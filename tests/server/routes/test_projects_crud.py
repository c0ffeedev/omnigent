"""Tests for the projects CRUD routes (``/v1/projects``).

The projects router is only mounted when ``create_app`` receives a
``project_store``. The standard conftest ``app`` fixture does not supply one, so
these tests build their own app/client that include it.

Two auth setups are exercised:

- **Single-user** (``project_client``) — no auth provider, so the owner scope is
  the reserved ``None``. This is the OSS / local default.
- **Multi-user** (``multi_user_client`` + ``as_user``) — header auth
  (``UnifiedAuthProvider(source="header")``), so each request's owner is the
  ``X-Forwarded-Email`` identity. Used to prove projects are owner-private: one
  user can never see or mutate another's projects.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.app import create_app
from omnigent.server.auth import UnifiedAuthProvider
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)
from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
from omnigent.stores.permission_store.sqlalchemy_store import (
    SqlAlchemyPermissionStore,
)
from omnigent.stores.project_store.sqlalchemy_store import SqlAlchemyProjectStore

ALICE = "alice@example.com"
BOB = "bob@example.com"


def _as_user(user: str) -> dict[str, str]:
    """Header identifying the requesting user under header auth."""
    return {"X-Forwarded-Email": user}


@pytest.fixture()
def project_app(runtime_init: None, db_uri: str, tmp_path: Path) -> FastAPI:
    """Build a FastAPI app that includes the project store."""
    artifact_store = LocalArtifactStore(str(tmp_path / "artifacts"))
    return create_app(
        agent_store=SqlAlchemyAgentStore(db_uri),
        file_store=SqlAlchemyFileStore(db_uri),
        conversation_store=SqlAlchemyConversationStore(db_uri),
        artifact_store=artifact_store,
        agent_cache=AgentCache(
            artifact_store=artifact_store,
            cache_dir=tmp_path / "cache",
        ),
        project_store=SqlAlchemyProjectStore(db_uri),
    )


@pytest_asyncio.fixture()
async def project_client(
    project_app: FastAPI,
) -> AsyncIterator[httpx.AsyncClient]:
    """HTTP client wired to the project-enabled app."""
    transport = httpx.ASGITransport(app=project_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_create_project(project_client: httpx.AsyncClient) -> None:
    """Creating a project returns the project object."""
    resp = await project_client.post("/v1/projects", json={"name": "My Project"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "My Project"
    assert body["object"] == "project"
    assert len(body["id"]) == 32
    assert body["updated_at"] is None


async def test_create_trims_and_rejects_empty(project_client: httpx.AsyncClient) -> None:
    """Names are trimmed; empty/whitespace-only names are rejected with 422."""
    resp = await project_client.post("/v1/projects", json={"name": "  Padded  "})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Padded"

    resp = await project_client.post("/v1/projects", json={"name": "   "})
    assert resp.status_code == 422


async def test_create_duplicate_name_conflicts(project_client: httpx.AsyncClient) -> None:
    """Two projects with the same name for one owner returns 409."""
    await project_client.post("/v1/projects", json={"name": "dup"})
    resp = await project_client.post("/v1/projects", json={"name": "dup"})
    assert resp.status_code == 409


async def test_list_projects(project_client: httpx.AsyncClient) -> None:
    """Listing returns the created projects."""
    await project_client.post("/v1/projects", json={"name": "A"})
    await project_client.post("/v1/projects", json={"name": "B"})
    resp = await project_client.get("/v1/projects")
    assert resp.status_code == 200
    body = resp.json()
    assert body["object"] == "list"
    assert {p["name"] for p in body["data"]} == {"A", "B"}


async def test_get_project(project_client: httpx.AsyncClient) -> None:
    """A created project can be fetched by id; unknown ids 404."""
    created = (await project_client.post("/v1/projects", json={"name": "X"})).json()
    resp = await project_client.get(f"/v1/projects/{created['id']}")
    assert resp.status_code == 200
    assert resp.json()["name"] == "X"

    missing = await project_client.get(f"/v1/projects/{'0' * 32}")
    assert missing.status_code == 404


async def test_rename_project(project_client: httpx.AsyncClient) -> None:
    """PATCH renames the project and stamps ``updated_at``."""
    created = (await project_client.post("/v1/projects", json={"name": "Old"})).json()
    resp = await project_client.patch(f"/v1/projects/{created['id']}", json={"name": "New"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "New"
    assert body["updated_at"] is not None


async def test_rename_missing_project_404(project_client: httpx.AsyncClient) -> None:
    """Renaming an unknown project returns 404."""
    resp = await project_client.patch(f"/v1/projects/{'0' * 32}", json={"name": "X"})
    assert resp.status_code == 404


async def test_delete_project(project_client: httpx.AsyncClient) -> None:
    """DELETE removes the project; a second delete 404s."""
    created = (await project_client.post("/v1/projects", json={"name": "Doomed"})).json()
    resp = await project_client.delete(f"/v1/projects/{created['id']}")
    assert resp.status_code == 200
    assert resp.json()["deleted"] is True

    second_delete = await project_client.delete(f"/v1/projects/{created['id']}")
    assert second_delete.status_code == 404


async def test_project_resources_group_work_concepts(
    project_client: httpx.AsyncClient,
) -> None:
    """Projects group typed links without introducing a parallel workset API."""
    project = (await project_client.post("/v1/projects", json={"name": "Workset"})).json()
    expected = [
        {"kind": "repository", "title": "omnigent", "reference": "https://example/omnigent"},
        {"kind": "task", "title": "Ship projects", "reference": "task-123"},
        {"kind": "decision", "title": "Reuse Projects", "reference": "session-456"},
        {"kind": "open_question", "title": "How should sharing work?", "reference": None},
    ]

    for payload in expected:
        response = await project_client.post(
            f"/v1/projects/{project['id']}/resources", json=payload
        )
        assert response.status_code == 200
        body = response.json()
        assert body["object"] == "project.resource"
        assert body["project_id"] == project["id"]
        assert {key: body[key] for key in payload} == payload

    response = await project_client.get(f"/v1/projects/{project['id']}/resources")
    assert response.status_code == 200
    assert response.json()["object"] == "list"
    actual = {}
    for item in response.json()["data"]:
        actual[item["kind"]] = (item["title"], item["reference"])
    expected_by_kind = {}
    for item in expected:
        expected_by_kind[item["kind"]] = (item["title"], item["reference"])
    assert actual == expected_by_kind


async def test_project_resources_filter_and_delete(project_client: httpx.AsyncClient) -> None:
    """Resource associations can be filtered and removed independently."""
    project = (await project_client.post("/v1/projects", json={"name": "Workset"})).json()
    repository = (
        await project_client.post(
            f"/v1/projects/{project['id']}/resources",
            json={"kind": "repository", "title": "omnigent"},
        )
    ).json()
    await project_client.post(
        f"/v1/projects/{project['id']}/resources",
        json={"kind": "decision", "title": "Reuse Projects"},
    )

    filtered = await project_client.get(
        f"/v1/projects/{project['id']}/resources", params={"kind": "decision"}
    )
    assert filtered.status_code == 200
    assert [item["kind"] for item in filtered.json()["data"]] == ["decision"]

    deleted = await project_client.delete(
        f"/v1/projects/{project['id']}/resources/{repository['id']}"
    )
    assert deleted.status_code == 200
    assert deleted.json() == {
        "id": repository["id"],
        "object": "project.resource.deleted",
        "deleted": True,
    }
    missing = await project_client.delete(
        f"/v1/projects/{project['id']}/resources/{repository['id']}"
    )
    assert missing.status_code == 404


async def test_project_resource_validation_and_missing_project(
    project_client: httpx.AsyncClient,
) -> None:
    """Resource kinds are closed and resources cannot target unknown projects."""
    project = (await project_client.post("/v1/projects", json={"name": "Workset"})).json()
    invalid_kind = await project_client.post(
        f"/v1/projects/{project['id']}/resources",
        json={"kind": "session", "title": "Already modeled upstream"},
    )
    assert invalid_kind.status_code == 422
    empty_title = await project_client.post(
        f"/v1/projects/{project['id']}/resources",
        json={"kind": "task", "title": "   "},
    )
    assert empty_title.status_code == 422

    missing_id = "0" * 32
    missing = await project_client.post(
        f"/v1/projects/{missing_id}/resources",
        json={"kind": "task", "title": "No project"},
    )
    assert missing.status_code == 404
    assert (await project_client.get(f"/v1/projects/{missing_id}/resources")).status_code == 404


# ── Multi-user: projects are owner-private ─────────────────────────────


@pytest.fixture()
def multi_user_app(runtime_init: None, db_uri: str, tmp_path: Path) -> FastAPI:
    """A project-enabled app with header auth, so each request has an owner."""
    artifact_store = LocalArtifactStore(str(tmp_path / "artifacts"))
    return create_app(
        agent_store=SqlAlchemyAgentStore(db_uri),
        file_store=SqlAlchemyFileStore(db_uri),
        conversation_store=SqlAlchemyConversationStore(db_uri),
        artifact_store=artifact_store,
        agent_cache=AgentCache(
            artifact_store=artifact_store,
            cache_dir=tmp_path / "cache",
        ),
        project_store=SqlAlchemyProjectStore(db_uri),
        auth_provider=UnifiedAuthProvider(source="header"),
        permission_store=SqlAlchemyPermissionStore(db_uri),
    )


@pytest_asyncio.fixture()
async def multi_user_client(
    multi_user_app: FastAPI,
) -> AsyncIterator[httpx.AsyncClient]:
    """HTTP client wired to the multi-user (header-auth) app."""
    transport = httpx.ASGITransport(app=multi_user_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_list_scoped_to_requesting_owner(
    multi_user_client: httpx.AsyncClient,
) -> None:
    """Each user sees only their own projects."""
    await multi_user_client.post("/v1/projects", json={"name": "Alice A"}, headers=_as_user(ALICE))
    await multi_user_client.post("/v1/projects", json={"name": "Bob B"}, headers=_as_user(BOB))

    alice = (await multi_user_client.get("/v1/projects", headers=_as_user(ALICE))).json()
    bob = (await multi_user_client.get("/v1/projects", headers=_as_user(BOB))).json()
    assert {p["name"] for p in alice["data"]} == {"Alice A"}
    assert {p["name"] for p in bob["data"]} == {"Bob B"}


async def test_same_name_allowed_across_users(
    multi_user_client: httpx.AsyncClient,
) -> None:
    """Two users may each own a project with the same name (per-owner uniqueness)."""
    a = await multi_user_client.post(
        "/v1/projects", json={"name": "Shared"}, headers=_as_user(ALICE)
    )
    b = await multi_user_client.post(
        "/v1/projects", json={"name": "Shared"}, headers=_as_user(BOB)
    )
    assert a.status_code == 200
    assert b.status_code == 200


async def test_cannot_get_another_users_project(
    multi_user_client: httpx.AsyncClient,
) -> None:
    """Bob's project is 404 (not found), never readable, for Alice."""
    created = (
        await multi_user_client.post(
            "/v1/projects", json={"name": "Bob only"}, headers=_as_user(BOB)
        )
    ).json()
    resp = await multi_user_client.get(f"/v1/projects/{created['id']}", headers=_as_user(ALICE))
    assert resp.status_code == 404
    # The owner still sees it.
    assert (
        await multi_user_client.get(f"/v1/projects/{created['id']}", headers=_as_user(BOB))
    ).status_code == 200


async def test_cannot_access_another_users_project_resources(
    multi_user_client: httpx.AsyncClient,
) -> None:
    """Project-resource reads and writes inherit the project's owner scope."""
    project = (
        await multi_user_client.post(
            "/v1/projects", json={"name": "Alice only"}, headers=_as_user(ALICE)
        )
    ).json()
    resource = (
        await multi_user_client.post(
            f"/v1/projects/{project['id']}/resources",
            json={"kind": "repository", "title": "omnigent"},
            headers=_as_user(ALICE),
        )
    ).json()

    path = f"/v1/projects/{project['id']}/resources"
    assert (await multi_user_client.get(path, headers=_as_user(BOB))).status_code == 404
    assert (
        await multi_user_client.post(
            path,
            json={"kind": "task", "title": "Intrude"},
            headers=_as_user(BOB),
        )
    ).status_code == 404
    assert (
        await multi_user_client.delete(f"{path}/{resource['id']}", headers=_as_user(BOB))
    ).status_code == 404
    owner_list = await multi_user_client.get(path, headers=_as_user(ALICE))
    assert [item["id"] for item in owner_list.json()["data"]] == [resource["id"]]


async def test_cannot_rename_another_users_project(
    multi_user_client: httpx.AsyncClient,
) -> None:
    """Alice cannot rename Bob's project (404), and it stays unchanged."""
    created = (
        await multi_user_client.post(
            "/v1/projects", json={"name": "Bob only"}, headers=_as_user(BOB)
        )
    ).json()
    resp = await multi_user_client.patch(
        f"/v1/projects/{created['id']}", json={"name": "Hacked"}, headers=_as_user(ALICE)
    )
    assert resp.status_code == 404
    still = (
        await multi_user_client.get(f"/v1/projects/{created['id']}", headers=_as_user(BOB))
    ).json()
    assert still["name"] == "Bob only"


async def test_cannot_delete_another_users_project(
    multi_user_client: httpx.AsyncClient,
) -> None:
    """Alice cannot delete Bob's project (404), and it survives."""
    created = (
        await multi_user_client.post(
            "/v1/projects", json={"name": "Bob only"}, headers=_as_user(BOB)
        )
    ).json()
    resp = await multi_user_client.delete(f"/v1/projects/{created['id']}", headers=_as_user(ALICE))
    assert resp.status_code == 404
    assert (
        await multi_user_client.get(f"/v1/projects/{created['id']}", headers=_as_user(BOB))
    ).status_code == 200
