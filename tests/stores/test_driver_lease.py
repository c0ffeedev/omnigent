"""Persisted session driver lease and fencing tests."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from omnigent.stores.conversation_store import DriverLeaseConflictError
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)

ALICE = "alice@example.com"
BOB = "bob@example.com"


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
