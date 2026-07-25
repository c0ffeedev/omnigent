"""Runner-side stale driver dispatch rejection tests."""

from __future__ import annotations

from typing import Any, cast

import httpx
import pytest

from omnigent.runner.app import create_runner_app
from omnigent.runtime.harnesses.process_manager import HarnessProcessManager


class _ValidationClient:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        self.posts: list[tuple[str, dict[str, Any]]] = []

    async def post(self, path: str, **kwargs: Any) -> httpx.Response:
        self.posts.append((path, kwargs))
        return httpx.Response(
            self.status_code,
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
