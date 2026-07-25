"""Runner-side stale driver dispatch rejection tests."""

from __future__ import annotations

import asyncio
from typing import Any, cast

import httpx
import pytest

from omnigent.runner.app import create_runner_app
from omnigent.runtime.harnesses.process_manager import HarnessProcessManager
from omnigent.spec.types import AgentSpec, ExecutorSpec
from tests.runner.conftest import (
    _FakeProcessManager,
    _ScriptedHarnessClient,
    _spec_resolver_returning,
    _sse,
)


class _ValidationClient:
    def __init__(
        self,
        *status_codes: int,
        requires_driver_claim: bool = False,
    ) -> None:
        self.status_codes = list(status_codes)
        self.requires_driver_claim = requires_driver_claim
        self.posts: list[tuple[str, dict[str, Any]]] = []

    async def get(self, path: str, **kwargs: Any) -> httpx.Response:
        del kwargs
        payload = (
            {"requires_driver_claim": self.requires_driver_claim}
            if path.endswith("/driver-dispatch/lease-state")
            else {"data": [], "has_more": False}
        )
        return httpx.Response(
            200,
            json=payload,
            request=httpx.Request("GET", f"http://server{path}"),
        )

    async def post(self, path: str, **kwargs: Any) -> httpx.Response:
        self.posts.append((path, kwargs))
        return httpx.Response(
            self.status_codes.pop(0),
            request=httpx.Request("POST", f"http://server{path}"),
        )


@pytest.mark.asyncio
async def test_runner_rejects_stale_driver_delivery_before_dispatch() -> None:
    """A server-rejected consumer claim never reaches runner execution state."""
    server = _ValidationClient(409)
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, object()),
        server_client=cast(httpx.AsyncClient, server),
    )
    observed: list[tuple[str, str]] = []

    async def barrier(point: str, dispatch_id: str) -> None:
        observed.append((point, dispatch_id))

    app.state.driver_fence_test_hook = barrier
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-1/events",
            json={
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "stale"}],
                "driver_claim": {
                    "dispatch_id": "1" * 32,
                    "event_id": "2" * 32,
                    "source_id": "source-1",
                    "effect_id": "3" * 32,
                    "driver_generation": 1,
                    "consumer_token": "4" * 32,
                    "consumer_generation": 2,
                    "runner_id": "runner-1",
                },
            },
        )

    assert response.status_code == 409
    assert observed == [("pre_execute", "1" * 32)]
    assert len(server.posts) == 1
    path, kwargs = server.posts[0]
    assert path == "/v1/runners/runner-1/sessions/session-1/driver-dispatch/validate"
    assert kwargs["json"] == {
        "dispatch_id": "1" * 32,
        "consumer_token": "4" * 32,
        "consumer_generation": 2,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event",
    [
        {"type": "message", "role": "user", "content": []},
        {"type": "tool_result", "call_id": "call_test", "output": "done"},
    ],
)
async def test_runner_rejects_missing_claim_when_session_is_leased(
    event: dict[str, Any],
) -> None:
    """A direct unfenced caller cannot execute against a leased session."""
    server = _ValidationClient(requires_driver_claim=True)
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, object()),
        server_client=cast(httpx.AsyncClient, server),
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-1/events",
            json=event,
        )

    assert response.status_code == 409
    assert response.json()["error"] == "missing_driver_claim"
    assert server.posts == []


@pytest.mark.asyncio
async def test_runner_revalidates_claim_at_background_execution_boundary() -> None:
    """A claim lost after HTTP acceptance cannot reach harness execution."""
    server = _ValidationClient(200, 409, 200)
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, object()),
        server_client=cast(httpx.AsyncClient, server),
    )
    entered = asyncio.Event()
    release = asyncio.Event()

    async def barrier(point: str, dispatch_id: str) -> None:
        del dispatch_id
        if point == "background_pre_execute":
            entered.set()
            await release.wait()

    app.state.driver_fence_test_hook = barrier
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-1/events",
            json={
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "race"}],
                "driver_claim": {
                    "dispatch_id": "1" * 32,
                    "event_id": "2" * 32,
                    "source_id": "source-1",
                    "effect_id": "3" * 32,
                    "driver_generation": 1,
                    "consumer_token": "4" * 32,
                    "consumer_generation": 2,
                    "runner_id": "runner-1",
                },
            },
        )
        assert response.status_code == 202
        await asyncio.wait_for(entered.wait(), timeout=1)
        release.set()
        for _ in range(20):
            if len(server.posts) >= 3:
                break
            await asyncio.sleep(0)

    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
        "complete",
    ]


@pytest.mark.asyncio
async def test_native_driver_claim_completes_only_after_forwarded_terminal_status() -> None:
    """A native prompt injection is not terminal completion of its fenced turn."""
    server = _ValidationClient(200, 200, 200)
    stream_finished = asyncio.Event()
    harness_client = _ScriptedHarnessClient(
        [_sse({"type": "response.created", "response": {"id": "resp-native"}})],
        stream_finished=stream_finished,
    )
    process_manager = _FakeProcessManager(harness_client)
    spec = AgentSpec(
        spec_version=1,
        name="native",
        executor=ExecutorSpec(type="omnigent", config={"harness": "claude-native"}),
    )
    resolver = await _spec_resolver_returning(spec)
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, process_manager),
        spec_resolver=resolver,
        server_client=cast(httpx.AsyncClient, server),
    )
    claim = {
        "dispatch_id": "1" * 32,
        "event_id": "2" * 32,
        "source_id": "source-native",
        "effect_id": "3" * 32,
        "driver_generation": 1,
        "consumer_token": "4" * 32,
        "consumer_generation": 2,
        "runner_id": "runner-1",
    }

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-native/events",
            json={
                "type": "message",
                "role": "user",
                "agent_id": "agent-native",
                "persisted_item_id": "turn-native",
                "content": [{"type": "input_text", "text": "work"}],
                "driver_claim": claim,
            },
        )
        assert response.status_code == 202
        await asyncio.wait_for(stream_finished.wait(), timeout=2.0)
        await asyncio.sleep(0)
        assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
            "validate",
            "validate",
        ]

        terminal = await client.post(
            "/v1/sessions/session-native/events",
            json={
                "type": "external_session_status",
                "data": {
                    "status": "idle",
                    "turn_id": "turn-native",
                    "response_id": "resp-native",
                },
            },
        )
        assert terminal.status_code == 204
        for _ in range(100):
            if len(server.posts) >= 3:
                break
            await asyncio.sleep(0.01)

    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
        "complete",
    ]
    assert server.posts[-1][1]["params"] == {"succeeded": True}
