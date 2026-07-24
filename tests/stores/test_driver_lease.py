"""Persisted session driver lease and fencing tests."""

from __future__ import annotations

import asyncio
import multiprocessing
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
import sqlalchemy as sa

from omnigent.db.db_models import (
    SqlSessionDriverDispatch,
    SqlSessionDriverEvent,
    workspace_scope,
)
from omnigent.stores.conversation_store import DriverLeaseConflictError
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)

ALICE = "alice@example.com"
BOB = "bob@example.com"


def _disconnect_on_next_commit(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Close the DBAPI connection so SQLAlchemy exercises disconnect handling."""
    original_commit = conversation_store._conv_engine.dialect.do_commit
    fail_next_commit = True

    def _disconnect(dbapi_connection: Any) -> None:
        nonlocal fail_next_commit
        if fail_next_commit:
            fail_next_commit = False
            dbapi_connection.driver_connection.close()
        original_commit(dbapi_connection)

    monkeypatch.setattr(
        conversation_store._conv_engine.dialect,
        "do_commit",
        _disconnect,
    )


def _hold_driver_event_in_process(
    db_uri: str,
    session_id: str,
    entered: Any,
    release: Any,
    observed: Any,
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    dispatch_id = store.begin_driver_event(session_id, ALICE, 1, "message")
    assert dispatch_id is not None
    entered.set()
    if not release.wait(timeout=10):
        raise TimeoutError("timed out waiting to release accepted driver event")
    lease = store.get_driver_lease(session_id)
    observed.put(lease.generation if lease is not None else None)
    store.complete_driver_event(session_id, dispatch_id, succeeded=True)


def _take_over_driver_in_process(
    db_uri: str,
    session_id: str,
    started: Any,
    done: Any,
    result: Any,
) -> None:
    store = SqlAlchemyConversationStore(db_uri)
    started.set()
    try:
        try:
            generation = store.acquire_driver_lease(session_id, BOB, 30, force=True).generation
        except DriverLeaseConflictError:
            result.put("conflict")
        else:
            result.put(generation)
    finally:
        done.set()


@pytest.mark.parametrize("side_effect", ["persist", "pending_enqueue", "runner_dispatch"])
def test_takeover_is_rejected_for_every_accepted_event_side_effect(
    conversation_store: SqlAlchemyConversationStore,
    side_effect: str,
) -> None:
    """A durable dispatch rejects takeover until every side effect completes."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    observed: list[tuple[str, int]] = []

    dispatch_id = conversation_store.begin_driver_event(session_id, ALICE, 1, "message")
    assert dispatch_id is not None
    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    lease = conversation_store.get_driver_lease(session_id)
    assert lease is not None
    observed.append((side_effect, lease.generation))
    conversation_store.complete_driver_event(session_id, dispatch_id, succeeded=True)
    assert conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True).generation == 2

    assert observed == [(side_effect, 1)]


def test_sqlite_takeover_waits_for_accepted_side_effect_across_processes(tmp_path) -> None:
    """SQLite replicas serialize dispatch and takeover through a filesystem lock."""
    db_uri = f"sqlite:///{tmp_path / 'conversation.db'}"
    store = SqlAlchemyConversationStore(db_uri)
    session_id = store.create_conversation().id
    store.acquire_driver_lease(session_id, ALICE, 30)

    context = multiprocessing.get_context("spawn")
    entered = context.Event()
    release = context.Event()
    takeover_started = context.Event()
    takeover_done = context.Event()
    observed = context.Queue()
    takeover_result = context.Queue()
    accepted = context.Process(
        target=_hold_driver_event_in_process,
        args=(db_uri, session_id, entered, release, observed),
    )
    takeover = context.Process(
        target=_take_over_driver_in_process,
        args=(db_uri, session_id, takeover_started, takeover_done, takeover_result),
    )

    accepted.start()
    try:
        assert entered.wait(timeout=10)
        takeover.start()
        assert takeover_started.wait(timeout=10)
        assert takeover_done.wait(timeout=10)
        assert takeover_result.get(timeout=1) == "conflict"
        release.set()
        accepted.join(timeout=10)
        takeover.join(timeout=10)
        assert accepted.exitcode == 0
        assert takeover.exitcode == 0
        assert observed.get(timeout=1) == 1
        assert store.acquire_driver_lease(session_id, BOB, 30, force=True).generation == 2
    finally:
        release.set()
        for process in (accepted, takeover):
            if process.is_alive():
                process.terminate()
            process.join(timeout=2)


def test_lease_resource_audit_failure_rolls_back_mutation(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The durable resource event and lease transition commit atomically."""
    session_id = conversation_store.create_conversation().id

    def fail_audit(*_: object, **__: object) -> None:
        raise RuntimeError("audit write failed")

    monkeypatch.setattr(conversation_store, "_append_driver_resource_event", fail_audit)
    with pytest.raises(RuntimeError, match="audit write failed"):
        conversation_store.acquire_driver_lease(session_id, ALICE, 30)

    assert conversation_store.get_driver_lease(session_id) is None
    assert conversation_store.list_items(session_id).data == []


def test_driver_acceptance_audit_failure_rolls_back_dispatch(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Acceptance audit and the durable dispatch claim commit atomically."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)

    def fail_audit(*_: object, **__: object) -> None:
        raise RuntimeError("acceptance audit failed")

    monkeypatch.setattr(conversation_store, "_record_driver_event", fail_audit)
    with pytest.raises(RuntimeError, match="acceptance audit failed"):
        conversation_store.begin_driver_event(session_id, ALICE, 1, "message")

    monkeypatch.undo()
    assert conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True).generation == 2


def test_driver_acceptance_commit_connection_loss_rolls_back_dispatch(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A lost acceptance commit cannot leave an unaudited active dispatch."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    _disconnect_on_next_commit(conversation_store, monkeypatch)

    with pytest.raises(sa.exc.DBAPIError) as error:
        conversation_store.begin_driver_event(session_id, ALICE, 1, "message")
    assert error.value.connection_invalidated

    dispatch_id = conversation_store.begin_driver_event(session_id, ALICE, 1, "message")
    assert dispatch_id is not None
    with conversation_store._conv_session() as session:
        accepted_event_count = session.scalar(
            sa.select(sa.func.count())
            .select_from(SqlSessionDriverEvent)
            .where(
                SqlSessionDriverEvent.session_id == session_id,
                SqlSessionDriverEvent.event_type == "input_accepted",
            )
        )
    assert accepted_event_count == 1
    conversation_store.complete_driver_event(session_id, dispatch_id, succeeded=True)


def test_driver_completion_commit_connection_loss_remains_fenced_until_retry(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A lost completion commit conservatively keeps takeover fenced."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    dispatch_id = conversation_store.begin_driver_event(session_id, ALICE, 1, "message")
    assert dispatch_id is not None
    _disconnect_on_next_commit(conversation_store, monkeypatch)

    with pytest.raises(sa.exc.DBAPIError) as error:
        conversation_store.complete_driver_event(session_id, dispatch_id, succeeded=True)
    assert error.value.connection_invalidated

    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    conversation_store.complete_driver_event(session_id, dispatch_id, succeeded=True)
    assert conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True).generation == 2


def test_expired_dispatch_is_recovered_after_restart_and_fences_old_owner(
    conversation_store: SqlAlchemyConversationStore,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A replica can tombstone a crashed dispatch and advance the lease generation."""
    from omnigent.stores.conversation_store import sqlalchemy_store as store_module

    session_id = conversation_store.create_conversation().id
    monkeypatch.setattr(store_module, "now_epoch", lambda: 100)
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    dispatch_id = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        claim_ttl_seconds=10,
    )
    assert dispatch_id is not None

    restarted_store = SqlAlchemyConversationStore(db_uri)
    monkeypatch.setattr(store_module, "now_epoch", lambda: 110)
    recovered = restarted_store.acquire_driver_lease(session_id, BOB, 30, force=True)

    assert recovered.generation == 2
    with pytest.raises(DriverLeaseConflictError, match="no longer active"):
        conversation_store.renew_driver_event(
            session_id,
            dispatch_id,
            claim_ttl_seconds=10,
        )
    with pytest.raises(DriverLeaseConflictError, match="no longer active"):
        conversation_store.complete_driver_event(session_id, dispatch_id, succeeded=True)
    with restarted_store._conv_session() as session:
        dispatch = session.get(SqlSessionDriverDispatch, (0, dispatch_id))
        assert dispatch is not None
        assert dispatch.state == "failed"
        assert dispatch.completed_at == 110
        assert dispatch.claim_expires_at is None


def test_dispatch_heartbeat_renews_before_boundary_and_expires_at_boundary(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Heartbeat renewal is strict: live before expiry, recoverable at expiry."""
    from omnigent.stores.conversation_store import sqlalchemy_store as store_module

    session_id = conversation_store.create_conversation().id
    monkeypatch.setattr(store_module, "now_epoch", lambda: 100)
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    dispatch_id = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        claim_ttl_seconds=10,
    )
    assert dispatch_id is not None

    monkeypatch.setattr(store_module, "now_epoch", lambda: 109)
    conversation_store.renew_driver_event(
        session_id,
        dispatch_id,
        claim_ttl_seconds=10,
    )
    monkeypatch.setattr(store_module, "now_epoch", lambda: 105)
    conversation_store.renew_driver_event(
        session_id,
        dispatch_id,
        claim_ttl_seconds=10,
    )
    monkeypatch.setattr(store_module, "now_epoch", lambda: 110)
    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)

    monkeypatch.setattr(store_module, "now_epoch", lambda: 116)
    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)

    monkeypatch.setattr(store_module, "now_epoch", lambda: 119)
    recovered = conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    assert recovered.generation == 2


def test_driver_mutations_hold_at_most_one_pool_connection_per_thread(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """Backend locks and mutations share one pool checkout per operation."""
    session_ids = [conversation_store.create_conversation().id for _ in range(8)]
    for session_id in session_ids:
        conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    engine = conversation_store._conv_engine
    counts: dict[int, int] = {}
    max_counts: dict[int, int] = {}
    counts_lock = threading.Lock()

    def _checkout(*_: Any) -> None:
        thread_id = threading.get_ident()
        with counts_lock:
            counts[thread_id] = counts.get(thread_id, 0) + 1
            max_counts[thread_id] = max(max_counts.get(thread_id, 0), counts[thread_id])

    def _checkin(*_: Any) -> None:
        thread_id = threading.get_ident()
        with counts_lock:
            counts[thread_id] = counts.get(thread_id, 0) - 1

    sa.event.listen(engine, "checkout", _checkout)
    sa.event.listen(engine, "checkin", _checkin)
    try:
        with ThreadPoolExecutor(max_workers=8) as executor:
            generations = list(
                executor.map(
                    lambda sid: (
                        conversation_store.renew_driver_lease(sid, ALICE, 1, 30).generation
                    ),
                    session_ids,
                )
            )
    finally:
        sa.event.remove(engine, "checkout", _checkout)
        sa.event.remove(engine, "checkin", _checkin)

    assert generations == [1] * len(session_ids)
    assert max(max_counts.values()) == 1


def test_driver_lease_lifecycle_is_generation_fenced(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """Every ownership transition advances or validates the fencing generation."""
    session_id = conversation_store.create_conversation().id

    assert conversation_store.validate_driver_lease(session_id, ALICE, None) is None
    acquired = conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    assert acquired.generation == 1
    assert acquired.holder_user_id == ALICE
    assert conversation_store.validate_driver_lease(session_id, ALICE, 1) == acquired

    with pytest.raises(DriverLeaseConflictError):
        conversation_store.validate_driver_lease(session_id, ALICE, None)
    with pytest.raises(DriverLeaseConflictError):
        conversation_store.validate_driver_lease(session_id, BOB, 1)
    with pytest.raises(DriverLeaseConflictError):
        conversation_store.acquire_driver_lease(session_id, BOB, 30)

    renewed = conversation_store.renew_driver_lease(session_id, ALICE, 1, 60)
    assert renewed.generation == 1
    handed_off = conversation_store.handoff_driver_lease(session_id, ALICE, BOB, 1, 30)
    assert handed_off.generation == 2
    assert handed_off.holder_user_id == BOB

    with pytest.raises(DriverLeaseConflictError):
        conversation_store.validate_driver_lease(session_id, ALICE, 1)
    assert conversation_store.validate_driver_lease(session_id, BOB, 2) == handed_off

    released = conversation_store.release_driver_lease(session_id, BOB, 2)
    assert released.holder_user_id is None
    with pytest.raises(DriverLeaseConflictError):
        conversation_store.validate_driver_lease(session_id, BOB, 2)

    reacquired = conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    assert reacquired.generation == 3


def test_expiry_fences_old_holder_and_allows_takeover(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expiry fences the old holder and a fresh acquire advances generation."""
    from omnigent.stores.conversation_store import sqlalchemy_store as store_module

    session_id = conversation_store.create_conversation().id
    monkeypatch.setattr(store_module, "now_epoch", lambda: 100)
    conversation_store.acquire_driver_lease(session_id, ALICE, 5)

    monkeypatch.setattr(store_module, "now_epoch", lambda: 105)
    with pytest.raises(DriverLeaseConflictError):
        conversation_store.validate_driver_lease(session_id, ALICE, 1)
    reacquired = conversation_store.acquire_driver_lease(session_id, BOB, 30)
    assert reacquired.generation == 2
    assert reacquired.holder_user_id == BOB


def test_acceptance_rechecks_generation_after_takeover(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """A takeover between an early check and acceptance fences stale work."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)

    conversation_store.validate_driver_lease(session_id, ALICE, 1)
    conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)

    with pytest.raises(DriverLeaseConflictError):
        conversation_store.begin_driver_event(session_id, ALICE, 1, "message")
    dispatch_id = conversation_store.begin_driver_event(session_id, BOB, 2, "message")
    assert dispatch_id is not None
    conversation_store.complete_driver_event(session_id, dispatch_id, succeeded=True)


def test_leases_use_conversation_database_in_split_db_mode(tmp_path) -> None:
    """Lease fencing and accepted inputs share the AP transaction database."""
    meta_uri = f"sqlite:///{tmp_path / 'meta.db'}"
    conversation_uri = f"sqlite:///{tmp_path / 'conversation.db'}"
    store = SqlAlchemyConversationStore(meta_uri, conversation_uri)
    session_id = store.create_conversation().id

    acquired = store.acquire_driver_lease(session_id, ALICE, 30)
    dispatch_id = store.begin_driver_event(session_id, ALICE, acquired.generation, "message")

    assert dispatch_id is not None
    store.complete_driver_event(session_id, dispatch_id, succeeded=True)
    inspector = sa.inspect(sa.create_engine(conversation_uri))
    assert "session_driver_leases" in inspector.get_table_names()
    assert "session_driver_events" in inspector.get_table_names()
    assert "session_driver_dispatches" in inspector.get_table_names()
    assert "driver_generation" in {
        column["name"] for column in inspector.get_columns("conversation_items")
    }


async def test_delete_cleans_driver_state_before_recreating_session_id(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """Deleting a session removes lease, audit, and dispatch tombstones."""
    session_id = "1234567890abcdef1234567890abcdef"
    conversation_store.create_conversation(conversation_id=session_id)
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    dispatch_id = conversation_store.begin_driver_event(session_id, ALICE, 1, "message")
    assert dispatch_id is not None
    conversation_store.complete_driver_event(session_id, dispatch_id, succeeded=True)

    assert await conversation_store.delete_conversation(session_id)
    assert conversation_store.get_driver_lease(session_id) is None

    conversation_store.create_conversation(conversation_id=session_id)
    assert conversation_store.validate_driver_lease(session_id, BOB, None) is None
    recreated = conversation_store.acquire_driver_lease(session_id, BOB, 30)
    assert recreated.generation == 1


async def test_driver_dispatch_preserves_nondefault_workspace_in_worker_thread(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """to_thread fencing reads and writes the request's tenant workspace."""
    with workspace_scope(42):
        session_id = conversation_store.create_conversation().id
        conversation_store.acquire_driver_lease(session_id, ALICE, 30)
        dispatch_id = await asyncio.to_thread(
            conversation_store.begin_driver_event,
            session_id,
            ALICE,
            1,
            "message",
        )
        assert dispatch_id is not None
        await asyncio.to_thread(
            conversation_store.complete_driver_event,
            session_id,
            dispatch_id,
            succeeded=True,
        )
        assert conversation_store.get_driver_lease(session_id) is not None

    assert conversation_store.get_driver_lease(session_id) is None


def test_concurrent_acquire_has_one_winner_across_store_instances(db_uri: str) -> None:
    """Two replicas racing an absent lease cannot both become generation one."""
    first = SqlAlchemyConversationStore(db_uri)
    second = SqlAlchemyConversationStore(db_uri)
    session_id = first.create_conversation().id

    def acquire(store: SqlAlchemyConversationStore, user_id: str) -> str:
        try:
            return store.acquire_driver_lease(session_id, user_id, 30).holder_user_id or ""
        except DriverLeaseConflictError:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda args: acquire(*args), [(first, ALICE), (second, BOB)]))

    assert outcomes.count("conflict") == 1
    winner = next(outcome for outcome in outcomes if outcome != "conflict")
    persisted = first.get_driver_lease(session_id)
    assert persisted is not None
    assert persisted.generation == 1
    assert persisted.holder_user_id == winner


def test_generation_round_trips_on_human_input(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """The accepted fencing token remains visible in durable item history."""
    from omnigent.entities import MessageData, NewConversationItem

    session_id = conversation_store.create_conversation().id
    [persisted] = conversation_store.append(
        session_id,
        [
            NewConversationItem(
                type="message",
                response_id="turn_1",
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "hello"}],
                ),
                created_by=ALICE,
                driver_generation=7,
            )
        ],
    )

    assert persisted.driver_generation == 7
    [loaded] = conversation_store.list_items(session_id).data
    assert loaded.driver_generation == 7
    assert loaded.to_api_dict()["driver_generation"] == 7
