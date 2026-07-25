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


def _control_claim() -> dict[str, Any]:
    return {
        "dispatch_id": "1" * 32,
        "event_id": "2" * 32,
        "source_id": "source-control",
        "effect_id": "3" * 32,
        "driver_generation": 1,
        "consumer_token": "4" * 32,
        "consumer_generation": 2,
        "runner_id": "runner-1",
    }


class _ControlHarnessClient:
    def __init__(self, status_code: int = 204) -> None:
        self.status_code = status_code
        self.entered = asyncio.Event()
        self.release: asyncio.Event | None = None

    async def post(self, path: str, **kwargs: Any) -> httpx.Response:
        del kwargs
        self.entered.set()
        if self.release is not None:
            await self.release.wait()
        return httpx.Response(
            self.status_code,
            request=httpx.Request("POST", f"http://harness{path}"),
        )


class _UncertainControlHarnessClient:
    async def post(self, path: str, **kwargs: Any) -> httpx.Response:
        del path, kwargs
        raise httpx.ReadTimeout("control outcome unknown")


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
    server = _ValidationClient(200, 409)
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
        await asyncio.sleep(0)

    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
    ]


@pytest.mark.asyncio
async def test_runner_revalidates_control_claim_at_side_effect_boundary() -> None:
    """A control claim lost after ingress cannot act on the harness."""
    server = _ValidationClient(200, 409)
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, object()),
        server_client=cast(httpx.AsyncClient, server),
    )
    observed: list[str] = []

    async def barrier(point: str, _dispatch_id: str) -> None:
        observed.append(point)

    app.state.driver_fence_test_hook = barrier
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-1/events",
            json={
                "type": "interrupt",
                "driver_claim": {
                    "dispatch_id": "1" * 32,
                    "event_id": "2" * 32,
                    "source_id": "source-control",
                    "effect_id": "3" * 32,
                    "driver_generation": 1,
                    "consumer_token": "4" * 32,
                    "consumer_generation": 2,
                    "runner_id": "runner-1",
                },
            },
        )

    assert response.status_code == 409
    assert observed == ["pre_execute", "control_pre_execute"]
    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
    ]


@pytest.mark.asyncio
async def test_driver_control_success_completes_terminal_claim() -> None:
    """A successful control side effect durably completes its claim."""
    server = _ValidationClient(200, 200, 200)
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, object()),
        server_client=cast(httpx.AsyncClient, server),
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-1/events",
            json={"type": "interrupt", "driver_claim": _control_claim()},
        )

    assert response.status_code == 204
    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
        "complete",
    ]
    assert server.posts[-1][1]["params"] == {"succeeded": True}


@pytest.mark.asyncio
async def test_driver_control_semantic_failure_completes_failed_claim() -> None:
    """A terminal harness error makes the control claim retryable as failed."""
    server = _ValidationClient(200, 200, 200)
    harness_client = _ControlHarnessClient(status_code=500)
    process_manager = _FakeProcessManager(cast(_ScriptedHarnessClient, harness_client))
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, process_manager),
        server_client=cast(httpx.AsyncClient, server),
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-1/events",
            json={
                "type": "tool_result",
                "call_id": "call-1",
                "output": "failed",
                "driver_claim": _control_claim(),
            },
        )

    assert response.status_code == 500
    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
        "complete",
    ]
    assert server.posts[-1][1]["params"] == {"succeeded": False}


@pytest.mark.asyncio
async def test_driver_control_heartbeat_loss_retains_uncertain_claim() -> None:
    """Fence loss during a control side effect cancels work without completion."""
    server = _ValidationClient(200, 200, 409)
    harness_client = _ControlHarnessClient()
    harness_client.release = asyncio.Event()
    process_manager = _FakeProcessManager(cast(_ScriptedHarnessClient, harness_client))
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, process_manager),
        server_client=cast(httpx.AsyncClient, server),
    )
    app.state.driver_heartbeat_interval_seconds = 0.01
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        request_task = asyncio.create_task(
            client.post(
                "/v1/sessions/session-1/events",
                json={
                    "type": "tool_result",
                    "call_id": "call-1",
                    "output": "blocked",
                    "driver_claim": _control_claim(),
                },
            )
        )
        await asyncio.wait_for(harness_client.entered.wait(), timeout=1.0)
        with pytest.raises(asyncio.CancelledError):
            await request_task

    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
        "heartbeat",
    ]


@pytest.mark.asyncio
async def test_driver_control_transport_uncertainty_retains_claim() -> None:
    """An ambiguous harness transport failure cannot make the effect retryable."""
    server = _ValidationClient(200, 200)
    process_manager = _FakeProcessManager(
        cast(_ScriptedHarnessClient, _UncertainControlHarnessClient())
    )
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, process_manager),
        server_client=cast(httpx.AsyncClient, server),
    )
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-1/events",
            json={
                "type": "tool_result",
                "call_id": "call-1",
                "output": "unknown",
                "driver_claim": _control_claim(),
            },
        )

    assert response.status_code == 502
    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
    ]


@pytest.mark.asyncio
async def test_driver_control_retries_duplicate_terminal_callback() -> None:
    """An ambiguous terminal callback retries while its heartbeat remains active."""
    server = _ValidationClient(200, 200, 503, *([200] * 20))
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, object()),
        server_client=cast(httpx.AsyncClient, server),
    )
    app.state.driver_completion_retry_interval_seconds = 0.03
    app.state.driver_heartbeat_interval_seconds = 0.005
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-1/events",
            json={"type": "interrupt", "driver_claim": _control_claim()},
        )

    assert response.status_code == 204
    actions = [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts]
    assert actions[:3] == ["validate", "validate", "complete"]
    assert actions.count("complete") == 2
    assert "heartbeat" in actions[3:-1]
    completion_kwargs = [kwargs for path, kwargs in server.posts if path.endswith("/complete")]
    assert completion_kwargs[0] == completion_kwargs[1]


@pytest.mark.asyncio
async def test_driver_control_stale_takeover_stops_terminal_retry() -> None:
    """A definitive stale completion is fenced instead of retried forever."""
    server = _ValidationClient(200, 200, 409)
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, object()),
        server_client=cast(httpx.AsyncClient, server),
    )
    app.state.driver_completion_retry_interval_seconds = 0.01
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-1/events",
            json={"type": "interrupt", "driver_claim": _control_claim()},
        )

    assert response.status_code == 409
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

        for data in (
            {"status": "idle"},
            {"status": "idle", "turn_id": "turn-other"},
        ):
            unrelated = await client.post(
                "/v1/sessions/session-native/events",
                json={"type": "external_session_status", "data": data},
            )
            assert unrelated.status_code == 204
            await asyncio.sleep(0)
            assert len(server.posts) == 2

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


@pytest.mark.asyncio
async def test_native_driver_heartbeat_loss_stops_and_waits_for_correlated_terminal() -> None:
    """Fence loss terminates native work before releasing its durable claim."""
    server = _ValidationClient(200, 200, 409, 200)
    harness_client = _ScriptedHarnessClient(
        [_sse({"type": "response.created", "response": {"id": "resp-native"}})]
    )
    process_manager = _FakeProcessManager(harness_client)
    spec = AgentSpec(
        spec_version=1,
        name="native",
        executor=ExecutorSpec(type="omnigent", config={"harness": "claude-native"}),
    )
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, process_manager),
        spec_resolver=await _spec_resolver_returning(spec),
        server_client=cast(httpx.AsyncClient, server),
    )
    app.state.driver_heartbeat_interval_seconds = 0.01
    app.state.driver_termination_timeout_seconds = 1.0
    stopped = asyncio.Event()
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

        async def stop_hook(conv: str) -> None:
            assert conv == "session-native"
            stopped.set()
            response = await client.post(
                f"/v1/sessions/{conv}/events",
                json={
                    "type": "external_session_status",
                    "data": {"status": "failed", "turn_id": "turn-native"},
                },
            )
            assert response.status_code == 204

        app.state.driver_fence_stop_test_hook = stop_hook
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
        await asyncio.wait_for(stopped.wait(), timeout=2.0)
        for _ in range(100):
            if len(server.posts) >= 4:
                break
            await asyncio.sleep(0.01)

    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
        "heartbeat",
        "complete",
    ]
    assert server.posts[-1][1]["params"] == {"succeeded": False}


@pytest.mark.asyncio
async def test_native_driver_heartbeat_loss_retains_claim_without_terminal_proof() -> None:
    """An unconfirmed native stop must not free the durable execution fence."""
    server = _ValidationClient(200, 200, 409)
    harness_client = _ScriptedHarnessClient(
        [_sse({"type": "response.created", "response": {"id": "resp-native"}})]
    )
    process_manager = _FakeProcessManager(harness_client)
    spec = AgentSpec(
        spec_version=1,
        name="native",
        executor=ExecutorSpec(type="omnigent", config={"harness": "claude-native"}),
    )
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, process_manager),
        spec_resolver=await _spec_resolver_returning(spec),
        server_client=cast(httpx.AsyncClient, server),
    )
    app.state.driver_heartbeat_interval_seconds = 0.01
    app.state.driver_termination_timeout_seconds = 0.01
    stopped = asyncio.Event()

    async def stop_hook(conv: str) -> None:
        assert conv == "session-native"
        stopped.set()

    app.state.driver_fence_stop_test_hook = stop_hook
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
                "driver_claim": {
                    "dispatch_id": "1" * 32,
                    "event_id": "2" * 32,
                    "source_id": "source-native",
                    "effect_id": "3" * 32,
                    "driver_generation": 1,
                    "consumer_token": "4" * 32,
                    "consumer_generation": 2,
                    "runner_id": "runner-1",
                },
            },
        )
        assert response.status_code == 202
        await asyncio.wait_for(stopped.wait(), timeout=2.0)
        await asyncio.sleep(0.05)

    assert [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts] == [
        "validate",
        "validate",
        "heartbeat",
    ]


@pytest.mark.asyncio
async def test_driver_semantic_failure_retries_terminal_acknowledgement() -> None:
    """A failed SSE turn stays failed while an ambiguous completion is retried."""
    server = _ValidationClient(200, 200, 503, 200)
    harness_client = _ScriptedHarnessClient(
        [_sse({"type": "response.failed", "response": {"status": "failed"}})]
    )
    process_manager = _FakeProcessManager(harness_client)
    spec = AgentSpec(
        spec_version=1,
        name="sdk",
        executor=ExecutorSpec(type="omnigent", config={"harness": "mock"}),
    )
    app = create_runner_app(
        process_manager=cast(HarnessProcessManager, process_manager),
        spec_resolver=await _spec_resolver_returning(spec),
        server_client=cast(httpx.AsyncClient, server),
    )
    app.state.driver_completion_retry_interval_seconds = 0.01
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://runner") as client:
        response = await client.post(
            "/v1/sessions/session-sdk/events",
            json={
                "type": "message",
                "role": "user",
                "agent_id": "agent-sdk",
                "persisted_item_id": "turn-sdk",
                "content": [{"type": "input_text", "text": "work"}],
                "driver_claim": {
                    "dispatch_id": "1" * 32,
                    "event_id": "2" * 32,
                    "source_id": "source-sdk",
                    "effect_id": "3" * 32,
                    "driver_generation": 1,
                    "consumer_token": "4" * 32,
                    "consumer_generation": 2,
                    "runner_id": "runner-1",
                },
            },
        )
        assert response.status_code == 202
        for _ in range(200):
            if len(server.posts) >= 4:
                break
            await asyncio.sleep(0.01)

    actions = [path.rsplit("/", 1)[-1] for path, _kwargs in server.posts]
    assert actions == ["validate", "validate", "complete", "complete"]
    assert server.posts[-2][1]["params"] == {"succeeded": False}
    assert server.posts[-1][1]["params"] == {"succeeded": False}
