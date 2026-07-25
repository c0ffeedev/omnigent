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
from omnigent.stores.conversation_store import (
    DriverDispatchClaim,
    DriverDispatchEnvelope,
    DriverLeaseConflictError,
)
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)

ALICE = "alice@example.com"
BOB = "bob@example.com"


def _begin_claim(
    store: SqlAlchemyConversationStore,
    session_id: str,
    actor_user_id: str,
    generation: int,
    *,
    source_id: str = "test-event",
    claim_ttl_seconds: int = 30,
) -> DriverDispatchClaim:
    claim = store.begin_driver_event(
        session_id,
        actor_user_id,
        generation,
        "message",
        source_id=source_id,
        claim_ttl_seconds=claim_ttl_seconds,
    )
    assert isinstance(claim, DriverDispatchClaim)
    return claim


def _enqueue_claim(
    store: SqlAlchemyConversationStore,
    session_id: str,
    actor_user_id: str,
    generation: int,
    *,
    source_id: str = "test-event",
    payload: dict[str, Any] | None = None,
    claim_ttl_seconds: int = 30,
) -> tuple[DriverDispatchEnvelope, DriverDispatchClaim]:
    envelope = store.enqueue_driver_event(
        session_id,
        actor_user_id,
        generation,
        "message",
        source_id=source_id,
        payload=payload,
    )
    assert isinstance(envelope, DriverDispatchEnvelope)
    claim = store.claim_driver_event(
        session_id,
        envelope.dispatch_id,
        actor_user_id,
        generation,
        claim_ttl_seconds=claim_ttl_seconds,
    )
    return envelope, claim


def _renew_claim(
    store: SqlAlchemyConversationStore,
    session_id: str,
    claim: DriverDispatchClaim,
    *,
    claim_ttl_seconds: int = 30,
) -> None:
    store.renew_driver_event(
        session_id,
        claim.dispatch_id,
        consumer_token=claim.consumer_token,
        consumer_generation=claim.consumer_generation,
        claim_ttl_seconds=claim_ttl_seconds,
    )


def _complete_claim(
    store: SqlAlchemyConversationStore,
    session_id: str,
    claim: DriverDispatchClaim,
    *,
    succeeded: bool,
) -> None:
    store.complete_driver_event(
        session_id,
        claim.dispatch_id,
        consumer_token=claim.consumer_token,
        consumer_generation=claim.consumer_generation,
        succeeded=succeeded,
    )


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
    claim = _begin_claim(store, session_id, ALICE, 1)
    entered.set()
    if not release.wait(timeout=10):
        raise TimeoutError("timed out waiting to release accepted driver event")
    lease = store.get_driver_lease(session_id)
    observed.put(lease.generation if lease is not None else None)
    _complete_claim(store, session_id, claim, succeeded=True)


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

    claim = _begin_claim(conversation_store, session_id, ALICE, 1)
    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    lease = conversation_store.get_driver_lease(session_id)
    assert lease is not None
    observed.append((side_effect, lease.generation))
    _complete_claim(conversation_store, session_id, claim, succeeded=True)
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
        _begin_claim(conversation_store, session_id, ALICE, 1)

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
        _begin_claim(conversation_store, session_id, ALICE, 1)
    assert error.value.connection_invalidated

    claim = _begin_claim(conversation_store, session_id, ALICE, 1)
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
    _complete_claim(conversation_store, session_id, claim, succeeded=True)


def test_driver_completion_commit_connection_loss_remains_fenced_until_retry(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A lost completion commit conservatively keeps takeover fenced."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    claim = _begin_claim(conversation_store, session_id, ALICE, 1)
    _disconnect_on_next_commit(conversation_store, monkeypatch)

    with pytest.raises(sa.exc.DBAPIError) as error:
        _complete_claim(conversation_store, session_id, claim, succeeded=True)
    assert error.value.connection_invalidated

    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    _complete_claim(conversation_store, session_id, claim, succeeded=True)
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
    claim = _begin_claim(
        conversation_store,
        session_id,
        ALICE,
        1,
        claim_ttl_seconds=10,
    )

    restarted_store = SqlAlchemyConversationStore(db_uri)
    monkeypatch.setattr(store_module, "now_epoch", lambda: 110)
    recovered = restarted_store.acquire_driver_lease(session_id, BOB, 30, force=True)

    assert recovered.generation == 2
    with pytest.raises(DriverLeaseConflictError, match="no longer active"):
        _renew_claim(conversation_store, session_id, claim, claim_ttl_seconds=10)
    with pytest.raises(DriverLeaseConflictError, match="no longer active"):
        _complete_claim(conversation_store, session_id, claim, succeeded=True)
    with restarted_store._conv_session() as session:
        dispatch = session.get(SqlSessionDriverDispatch, (0, claim.dispatch_id))
        assert dispatch is not None
        assert dispatch.state == "failed"
        assert dispatch.completed_at == 110
        assert dispatch.claim_expires_at is None


def test_expired_executing_dispatch_remains_fenced_until_terminal_confirmation(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Execution-time expiry is poisoned until its exact consumer settles it."""
    from omnigent.stores.conversation_store import sqlalchemy_store as store_module

    session_id = conversation_store.create_conversation().id
    monkeypatch.setattr(store_module, "now_epoch", lambda: 100)
    conversation_store.acquire_driver_lease(session_id, ALICE, 10)
    claim = _begin_claim(
        conversation_store,
        session_id,
        ALICE,
        1,
        claim_ttl_seconds=10,
    )
    conversation_store.validate_driver_event(
        session_id,
        claim.dispatch_id,
        consumer_token=claim.consumer_token,
        consumer_generation=claim.consumer_generation,
    )

    monkeypatch.setattr(store_module, "now_epoch", lambda: 110)
    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)

    _complete_claim(conversation_store, session_id, claim, succeeded=False)
    takeover = conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    assert takeover.generation == 2


def test_dispatch_heartbeat_renews_before_boundary_and_expires_at_boundary(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Heartbeat renewal is strict: live before expiry, recoverable at expiry."""
    from omnigent.stores.conversation_store import sqlalchemy_store as store_module

    session_id = conversation_store.create_conversation().id
    monkeypatch.setattr(store_module, "now_epoch", lambda: 100)
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    claim = _begin_claim(
        conversation_store,
        session_id,
        ALICE,
        1,
        claim_ttl_seconds=10,
    )

    monkeypatch.setattr(store_module, "now_epoch", lambda: 109)
    _renew_claim(conversation_store, session_id, claim, claim_ttl_seconds=10)
    monkeypatch.setattr(store_module, "now_epoch", lambda: 105)
    _renew_claim(conversation_store, session_id, claim, claim_ttl_seconds=10)
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
    claim = _begin_claim(conversation_store, session_id, BOB, 2)
    _complete_claim(conversation_store, session_id, claim, succeeded=True)


def test_leases_use_conversation_database_in_split_db_mode(tmp_path) -> None:
    """Lease fencing and accepted inputs share the AP transaction database."""
    meta_uri = f"sqlite:///{tmp_path / 'meta.db'}"
    conversation_uri = f"sqlite:///{tmp_path / 'conversation.db'}"
    store = SqlAlchemyConversationStore(meta_uri, conversation_uri)
    session_id = store.create_conversation().id

    acquired = store.acquire_driver_lease(session_id, ALICE, 30)
    claim = _begin_claim(store, session_id, ALICE, acquired.generation)

    _complete_claim(store, session_id, claim, succeeded=True)
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
    claim = _begin_claim(conversation_store, session_id, ALICE, 1)
    _complete_claim(conversation_store, session_id, claim, succeeded=True)

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
        claim = await asyncio.to_thread(
            conversation_store.begin_driver_event,
            session_id,
            ALICE,
            1,
            "message",
            source_id="test-event",
        )
        assert isinstance(claim, DriverDispatchClaim)
        await asyncio.to_thread(
            conversation_store.complete_driver_event,
            session_id,
            claim.dispatch_id,
            consumer_token=claim.consumer_token,
            consumer_generation=claim.consumer_generation,
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


def test_completed_dispatch_completion_is_a_terminal_noop(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """An exact duplicate completion is an idempotent terminal acknowledgement.

    Models an at-least-once outbox consumer redelivering the completion for a
    dispatch that already finished: the second call must not resurrect the
    claim, flip its terminal state, or mutate ``completed_at``. A conflicting
    terminal result and a renewal remain fenced.
    """
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    claim = _begin_claim(conversation_store, session_id, ALICE, 1)
    _complete_claim(conversation_store, session_id, claim, succeeded=True)

    with conversation_store._conv_session() as session:
        settled = session.get(SqlSessionDriverDispatch, (0, claim.dispatch_id))
        assert settled is not None
        first_state = settled.state
        first_completed_at = settled.completed_at
    assert first_state == "completed"
    assert settled.claim_expires_at is None

    for _ in range(2):
        _complete_claim(conversation_store, session_id, claim, succeeded=True)
        with pytest.raises(DriverLeaseConflictError, match="no longer active"):
            _complete_claim(conversation_store, session_id, claim, succeeded=False)
        with pytest.raises(DriverLeaseConflictError, match="no longer active"):
            _renew_claim(conversation_store, session_id, claim)

    with conversation_store._conv_session() as session:
        unchanged = session.get(SqlSessionDriverDispatch, (0, claim.dispatch_id))
        assert unchanged is not None
        assert unchanged.state == first_state
        assert unchanged.completed_at == first_completed_at
        assert unchanged.claim_expires_at is None


def test_completed_source_returns_existing_terminal_claim(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """A retried source id resolves to its settled effect without reopening it."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    first = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="source-once",
    )
    assert isinstance(first, DriverDispatchClaim)
    conversation_store.complete_driver_event(
        session_id,
        first.dispatch_id,
        consumer_token=first.consumer_token,
        consumer_generation=first.consumer_generation,
        succeeded=True,
    )

    duplicate = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="source-once",
    )

    assert isinstance(duplicate, DriverDispatchClaim)
    assert duplicate.completed is True
    assert duplicate.dispatch_id == first.dispatch_id
    assert duplicate.event_id == first.event_id
    assert duplicate.effect_id == first.effect_id


def test_leased_driver_event_requires_stable_source_identity(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """Lease-protected inputs cannot fall back to a retry-unstable server id."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)

    with pytest.raises(DriverLeaseConflictError, match="source_id is required"):
        conversation_store.begin_driver_event(session_id, ALICE, 1, "message")

    with conversation_store._conv_session() as session:
        assert (
            session.scalar(
                sa.select(sa.func.count())
                .select_from(SqlSessionDriverDispatch)
                .where(SqlSessionDriverDispatch.session_id == session_id)
            )
            == 0
        )


def test_source_identity_rejects_conflicting_payload_without_mutation(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """The idempotency key cannot identify two different event payloads."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    first_payload = {"type": "message", "data": {"text": "first"}}
    first = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="stable-source",
        payload=first_payload,
    )
    assert isinstance(first, DriverDispatchClaim)

    with pytest.raises(DriverLeaseConflictError, match="source identity was reused"):
        conversation_store.begin_driver_event(
            session_id,
            ALICE,
            1,
            "message",
            source_id="stable-source",
            payload={"type": "message", "data": {"text": "different"}},
        )

    with conversation_store._conv_session() as session:
        persisted = session.get(SqlSessionDriverDispatch, (0, first.dispatch_id))
        assert persisted is not None
        assert persisted.state == "running"
        assert persisted.consumer_generation == first.consumer_generation
        assert persisted.payload_json == '{"data":{"text":"first"},"type":"message"}'


def test_source_identity_cannot_cross_driver_generation(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """A settled source belongs to the actor and generation that accepted it."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    first = _begin_claim(
        conversation_store,
        session_id,
        ALICE,
        1,
        source_id="generation-bound-source",
    )
    _complete_claim(conversation_store, session_id, first, succeeded=True)
    conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)

    with pytest.raises(DriverLeaseConflictError, match="source identity was reused"):
        _begin_claim(
            conversation_store,
            session_id,
            BOB,
            2,
            source_id="generation-bound-source",
        )

    with conversation_store._conv_session() as session:
        dispatches = session.scalars(
            sa.select(SqlSessionDriverDispatch).where(
                SqlSessionDriverDispatch.session_id == session_id
            )
        ).all()
    assert [dispatch.id for dispatch in dispatches] == [first.dispatch_id]
    assert dispatches[0].state == "completed"


def test_concurrent_duplicate_source_creates_one_dispatch(db_uri: str) -> None:
    """Replica races serialize one source into one durable side-effect claim."""
    first_store = SqlAlchemyConversationStore(db_uri)
    second_store = SqlAlchemyConversationStore(db_uri)
    session_id = first_store.create_conversation().id
    first_store.acquire_driver_lease(session_id, ALICE, 30)
    barrier = threading.Barrier(2)

    def begin(store: SqlAlchemyConversationStore) -> DriverDispatchClaim | str:
        barrier.wait(timeout=5)
        try:
            claim = store.begin_driver_event(
                session_id,
                ALICE,
                1,
                "message",
                source_id="concurrent-source",
                payload={"type": "message", "data": {"text": "once"}},
            )
        except DriverLeaseConflictError as exc:
            return str(exc)
        assert isinstance(claim, DriverDispatchClaim)
        return claim

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(begin, [first_store, second_store]))

    claims = [outcome for outcome in outcomes if isinstance(outcome, DriverDispatchClaim)]
    conflicts = [outcome for outcome in outcomes if isinstance(outcome, str)]
    assert len(claims) == 1
    assert conflicts == ["driver dispatch is in progress"]

    claim = claims[0]
    _complete_claim(first_store, session_id, claim, succeeded=True)
    duplicate = second_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="concurrent-source",
        payload={"data": {"text": "once"}, "type": "message"},
    )
    assert isinstance(duplicate, DriverDispatchClaim)
    assert duplicate.completed is True
    assert duplicate.dispatch_id == claim.dispatch_id
    assert duplicate.effect_id == claim.effect_id

    with first_store._conv_session() as session:
        dispatch_count = session.scalar(
            sa.select(sa.func.count())
            .select_from(SqlSessionDriverDispatch)
            .where(SqlSessionDriverDispatch.session_id == session_id)
        )
        accepted_count = session.scalar(
            sa.select(sa.func.count())
            .select_from(SqlSessionDriverEvent)
            .where(
                SqlSessionDriverEvent.session_id == session_id,
                SqlSessionDriverEvent.event_type == "input_accepted",
            )
        )
    assert dispatch_count == accepted_count == 1


@pytest.mark.parametrize(
    ("consumer_token", "consumer_generation"),
    [("0" * 32, 1), (None, 2)],
)
def test_consumer_fence_mismatch_cannot_transition_running_dispatch(
    conversation_store: SqlAlchemyConversationStore,
    consumer_token: str | None,
    consumer_generation: int,
) -> None:
    """Only the current consumer token and generation may settle a claim."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    claim = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="consumer-fenced",
        payload={"type": "message", "data": {}},
    )
    assert isinstance(claim, DriverDispatchClaim)

    with pytest.raises(DriverLeaseConflictError, match="no longer active"):
        conversation_store.renew_driver_event(
            session_id,
            claim.dispatch_id,
            consumer_token=consumer_token,
            consumer_generation=consumer_generation,
        )
    with pytest.raises(DriverLeaseConflictError, match="no longer active"):
        conversation_store.complete_driver_event(
            session_id,
            claim.dispatch_id,
            consumer_token=consumer_token,
            consumer_generation=consumer_generation,
            succeeded=True,
        )

    with conversation_store._conv_session() as session:
        persisted = session.get(SqlSessionDriverDispatch, (0, claim.dispatch_id))
        assert persisted is not None
        assert persisted.state == "running"
        assert persisted.completed_at is None


def test_failed_source_retry_is_the_only_terminal_reopen_transition(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """A failed effect retries in place while a completed effect stays terminal."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    payload = {"type": "message", "data": {"text": "retry me"}}
    first = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="failed-retry",
        payload=payload,
    )
    assert isinstance(first, DriverDispatchClaim)
    conversation_store.complete_driver_event(
        session_id,
        first.dispatch_id,
        consumer_token=first.consumer_token,
        consumer_generation=first.consumer_generation,
        succeeded=False,
    )

    retry = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="failed-retry",
        payload=payload,
    )
    assert isinstance(retry, DriverDispatchClaim)
    assert retry.dispatch_id == first.dispatch_id
    assert retry.effect_id == first.effect_id
    assert retry.consumer_generation == first.consumer_generation + 1
    conversation_store.complete_driver_event(
        session_id,
        retry.dispatch_id,
        consumer_token=retry.consumer_token,
        consumer_generation=retry.consumer_generation,
        succeeded=True,
    )

    completed = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="failed-retry",
        payload=payload,
    )
    assert isinstance(completed, DriverDispatchClaim)
    assert completed.completed is True
    assert completed.consumer_generation == retry.consumer_generation


def test_stale_generation_acceptance_leaves_no_durable_trace(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """A stale-generation acceptance persists neither an audit nor a dispatch.

    After a force takeover advances the generation, the old holder's retried
    acceptance must be a hard reject with zero side effects: no ``input_accepted``
    audit row and no dispatch row, so the rejected turn cannot execute or split
    the audit trail.
    """
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)

    for _ in range(3):
        with pytest.raises(
            DriverLeaseConflictError,
            match="stale, expired, or not held",
        ):
            conversation_store.begin_driver_event(session_id, ALICE, 1, "message")

    with conversation_store._conv_session() as session:
        accepted = session.scalar(
            sa.select(sa.func.count())
            .select_from(SqlSessionDriverEvent)
            .where(
                SqlSessionDriverEvent.session_id == session_id,
                SqlSessionDriverEvent.event_type == "input_accepted",
            )
        )
        dispatch_rows = session.scalar(
            sa.select(sa.func.count())
            .select_from(SqlSessionDriverDispatch)
            .where(SqlSessionDriverDispatch.session_id == session_id)
        )
    assert accepted == 0
    assert dispatch_rows == 0

    # The current-generation holder still accepts exactly once.
    claim = _begin_claim(conversation_store, session_id, BOB, 2)
    _complete_claim(conversation_store, session_id, claim, succeeded=True)


def test_lost_transition_commit_retry_does_not_duplicate_audit(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A retried lease transition emits exactly one durable audit resource event.

    A lost commit rolls the lease mutation and its resource event back together;
    the client retry then commits a single ``acquired``/``taken_over`` pair, so
    the transition audit is neither lost nor duplicated across recovery.
    """
    session_id = conversation_store.create_conversation().id

    def _lease_events() -> list[str]:
        return [
            getattr(item.data, "event_type", None)
            for item in conversation_store.list_items(session_id).data
            if item.type == "resource_event"
            and getattr(item.data, "resource_type", None) == "driver_lease"
        ]

    _disconnect_on_next_commit(conversation_store, monkeypatch)
    with pytest.raises(sa.exc.DBAPIError) as error:
        conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    assert error.value.connection_invalidated
    # The rolled-back transition left no partial audit behind.
    assert _lease_events() == []
    assert conversation_store.get_driver_lease(session_id) is None

    acquired = conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    assert acquired.generation == 1
    assert _lease_events() == ["session.driver_lease.acquired"]

    _disconnect_on_next_commit(conversation_store, monkeypatch)
    with pytest.raises(sa.exc.DBAPIError) as takeover_error:
        conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    assert takeover_error.value.connection_invalidated
    # The failed takeover neither advanced the generation nor duplicated audit.
    assert conversation_store.get_driver_lease(session_id).generation == 1
    assert _lease_events() == ["session.driver_lease.acquired"]

    taken_over = conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    assert taken_over.generation == 2
    assert _lease_events() == [
        "session.driver_lease.acquired",
        "session.driver_lease.taken_over",
    ]


def test_release_and_handoff_are_fenced_by_an_active_dispatch(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """Lease teardown cannot split a turn that has an in-flight dispatch.

    ``release`` and ``handoff`` must reject while a durable dispatch is running
    (so a settling turn is never orphaned mid-side-effect) and succeed only once
    the dispatch reaches a terminal state.
    """
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    claim = _begin_claim(conversation_store, session_id, ALICE, 1)

    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.release_driver_lease(session_id, ALICE, 1)
    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.handoff_driver_lease(session_id, ALICE, BOB, 1, 30)

    # The fenced-out teardown wrote no lease audit and left the lease intact.
    lease = conversation_store.get_driver_lease(session_id)
    assert lease is not None
    assert lease.generation == 1
    assert lease.holder_user_id == ALICE
    assert lease.released_at is None

    _complete_claim(conversation_store, session_id, claim, succeeded=True)

    handed_off = conversation_store.handoff_driver_lease(session_id, ALICE, BOB, 1, 30)
    assert handed_off.generation == 2
    assert handed_off.holder_user_id == BOB
    released = conversation_store.release_driver_lease(session_id, BOB, 2)
    assert released.holder_user_id is None


def test_driver_source_identity_and_consumer_claim_are_persisted_atomically(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)

    claim = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="client-event-1",
        payload={"type": "message", "data": {"text": "hello"}},
    )

    assert isinstance(claim, DriverDispatchClaim)
    with conversation_store._conv_session() as session:
        dispatch = session.get(SqlSessionDriverDispatch, (0, claim.dispatch_id))
        event = session.get(SqlSessionDriverEvent, (0, claim.event_id))
        assert dispatch is not None
        assert event is not None
        assert dispatch.source_id == event.source_id == "client-event-1"
        assert dispatch.payload_json == '{"data":{"text":"hello"},"type":"message"}'
        assert dispatch.effect_id == claim.effect_id
        assert dispatch.consumer_token == claim.consumer_token
        assert dispatch.consumer_generation == 1


def test_consumer_claim_recovery_rotates_fence_and_preserves_effect_identity(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from omnigent.stores.conversation_store import sqlalchemy_store as store_module

    session_id = conversation_store.create_conversation().id
    monkeypatch.setattr(store_module, "now_epoch", lambda: 100)
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    first = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="retryable-input",
        claim_ttl_seconds=10,
    )
    assert isinstance(first, DriverDispatchClaim)

    with pytest.raises(DriverLeaseConflictError, match="no longer active"):
        conversation_store.renew_driver_event(
            session_id,
            first.dispatch_id,
            consumer_token="0" * 32,
            consumer_generation=first.consumer_generation,
        )

    monkeypatch.setattr(store_module, "now_epoch", lambda: 110)
    recovered = conversation_store.begin_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="retryable-input",
        claim_ttl_seconds=10,
    )
    assert isinstance(recovered, DriverDispatchClaim)
    assert recovered.dispatch_id == first.dispatch_id
    assert recovered.event_id == first.event_id
    assert recovered.effect_id == first.effect_id
    assert recovered.consumer_token != first.consumer_token
    assert recovered.consumer_generation == first.consumer_generation + 1

    with pytest.raises(DriverLeaseConflictError, match="no longer active"):
        conversation_store.complete_driver_event(
            session_id,
            first.dispatch_id,
            consumer_token=first.consumer_token,
            consumer_generation=first.consumer_generation,
            succeeded=True,
        )
    conversation_store.complete_driver_event(
        session_id,
        recovered.dispatch_id,
        consumer_token=recovered.consumer_token,
        consumer_generation=recovered.consumer_generation,
        succeeded=True,
    )


def test_outbox_enqueue_is_durable_before_consumer_claim(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """Acceptance commits a payload-bearing pending row before any consumer owns it."""
    session_id = conversation_store.create_conversation().id
    conversation_store.acquire_driver_lease(session_id, ALICE, 30)
    payload = {"type": "message", "data": {"text": "durable"}}

    envelope = conversation_store.enqueue_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="durable-before-claim",
        payload=payload,
    )

    assert isinstance(envelope, DriverDispatchEnvelope)
    assert envelope.payload == payload
    assert envelope.completed is False
    with conversation_store._conv_session() as session:
        row = session.get(SqlSessionDriverDispatch, (0, envelope.dispatch_id))
        assert row is not None
        assert row.state == "pending"
        assert row.consumer_token is None
        assert row.consumer_generation == 0
        assert row.claim_expires_at is None


def test_pending_outbox_fences_lease_transitions_until_accepting_lease_expires(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The enqueue/claim split cannot be overtaken while accepted work is pending."""
    from omnigent.stores.conversation_store import sqlalchemy_store as store_module

    session_id = conversation_store.create_conversation().id
    monkeypatch.setattr(store_module, "now_epoch", lambda: 100)
    conversation_store.acquire_driver_lease(session_id, ALICE, 5)
    envelope = conversation_store.enqueue_driver_event(
        session_id,
        ALICE,
        1,
        "message",
        source_id="pause-after-enqueue",
        payload={"type": "message", "data": {"text": "accepted"}},
    )
    assert isinstance(envelope, DriverDispatchEnvelope)

    monkeypatch.setattr(store_module, "now_epoch", lambda: 101)
    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.release_driver_lease(session_id, ALICE, 1)
    with pytest.raises(DriverLeaseConflictError, match="dispatch is in progress"):
        conversation_store.handoff_driver_lease(session_id, ALICE, BOB, 1, 30)

    monkeypatch.setattr(store_module, "now_epoch", lambda: 105)
    takeover = conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    assert takeover.generation == 2
    with conversation_store._conv_session() as session:
        row = session.get(SqlSessionDriverDispatch, (0, envelope.dispatch_id))
        assert row is not None
        assert row.state == "failed"
        assert row.completed_at == 105
    with pytest.raises(DriverLeaseConflictError, match="stale, expired, or not held"):
        conversation_store.claim_driver_event(
            session_id,
            envelope.dispatch_id,
            ALICE,
            1,
        )


def test_claim_loads_canonical_payload_and_heartbeat_is_separate(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Claim returns stored work while only an explicit heartbeat extends ownership."""
    from omnigent.stores.conversation_store import sqlalchemy_store as store_module

    session_id = conversation_store.create_conversation().id
    monkeypatch.setattr(store_module, "now_epoch", lambda: 100)
    conversation_store.acquire_driver_lease(session_id, ALICE, 60)
    payload = {"type": "message", "data": {"text": "stored"}}
    envelope, claim = _enqueue_claim(
        conversation_store,
        session_id,
        ALICE,
        1,
        source_id="claim-payload",
        payload=payload,
        claim_ttl_seconds=10,
    )

    assert claim.dispatch_id == envelope.dispatch_id
    assert claim.payload == payload
    assert claim.claim_expires_at == 110
    monkeypatch.setattr(store_module, "now_epoch", lambda: 104)
    conversation_store.validate_driver_event(
        session_id,
        claim.dispatch_id,
        consumer_token=claim.consumer_token,
        consumer_generation=claim.consumer_generation,
    )
    with conversation_store._conv_session() as session:
        row = session.get(SqlSessionDriverDispatch, (0, claim.dispatch_id))
        assert row is not None
        assert row.claim_expires_at == 110

    _renew_claim(conversation_store, session_id, claim, claim_ttl_seconds=10)
    with conversation_store._conv_session() as session:
        row = session.get(SqlSessionDriverDispatch, (0, claim.dispatch_id))
        assert row is not None
        assert row.claim_expires_at == 114
        assert row.state == "executing"

    _complete_claim(conversation_store, session_id, claim, succeeded=True)
    with conversation_store._conv_session() as session:
        row = session.get(SqlSessionDriverDispatch, (0, claim.dispatch_id))
        assert row is not None
        assert row.state == "completed"


def test_stale_consumer_validation_fails_after_expiry_takeover(
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A delayed delivery cannot execute after its claim expires and generation advances."""
    from omnigent.stores.conversation_store import sqlalchemy_store as store_module

    session_id = conversation_store.create_conversation().id
    monkeypatch.setattr(store_module, "now_epoch", lambda: 100)
    conversation_store.acquire_driver_lease(session_id, ALICE, 5)
    _, stale = _enqueue_claim(
        conversation_store,
        session_id,
        ALICE,
        1,
        source_id="stale-delivery",
        claim_ttl_seconds=5,
    )

    monkeypatch.setattr(store_module, "now_epoch", lambda: 105)
    takeover = conversation_store.acquire_driver_lease(session_id, BOB, 30, force=True)
    assert takeover.generation == 2
    with pytest.raises(DriverLeaseConflictError, match="no longer active"):
        conversation_store.validate_driver_event(
            session_id,
            stale.dispatch_id,
            consumer_token=stale.consumer_token,
            consumer_generation=stale.consumer_generation,
        )
