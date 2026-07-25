"""E2E coverage for the explicit session-driver handoff controls."""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterator

import httpx
import pytest
from playwright.sync_api import Browser, expect

from tests.e2e_ui.collaboration._multi_user_server import (
    ADMIN_EMAIL,
    MultiUserServer,
    spawn_multi_user_server,
)

_LEVEL_EDIT = 2


@pytest.fixture(scope="module")
def driver_server(
    built_spa: None,
    mock_llm_server_url: str,
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[MultiUserServer]:
    """Run driver controls against real multi-user header authentication."""
    server_tmp = tmp_path_factory.mktemp("e2e_ui_driver_handoff")
    yield from spawn_multi_user_server(mock_llm_server_url, server_tmp)


def test_driver_acquire_handoff_and_release_are_keyboard_operable(
    browser: Browser,
    driver_server: MultiUserServer,
) -> None:
    """Two live collaborators can acquire, confirm a handoff, and release control."""
    base_url = driver_server.base_url
    public_url = driver_server.public_url
    session_id = driver_server.session_id
    collaborator_email = f"driver-{uuid.uuid4().hex[:8]}@ui.test"
    httpx.put(
        f"{base_url}/v1/sessions/{session_id}/permissions",
        json={"user_id": collaborator_email, "level": _LEVEL_EDIT},
        headers={"X-Forwarded-Email": ADMIN_EMAIL},
        timeout=10.0,
    ).raise_for_status()

    owner_context = browser.new_context(extra_http_headers={"X-Forwarded-Email": ADMIN_EMAIL})
    collaborator_context = browser.new_context(
        extra_http_headers={"X-Forwarded-Email": collaborator_email}
    )
    try:
        owner = owner_context.new_page()
        collaborator = collaborator_context.new_page()
        owner.goto(f"{public_url}/c/{session_id}")
        collaborator.goto(f"{public_url}/c/{session_id}")

        presence_payload: dict[str, list[str]] = {}
        for email in (ADMIN_EMAIL, collaborator_email):
            presence_payload = (
                httpx.post(
                    f"{base_url}/v1/sessions/{session_id}/presence/heartbeat",
                    json={"ttl_seconds": 60},
                    headers={"X-Forwarded-Email": email},
                    timeout=10.0,
                )
                .raise_for_status()
                .json()
            )
        assert set(presence_payload["active_user_ids"]) == {
            ADMIN_EMAIL,
            collaborator_email,
        }
        owner.reload()

        expect(owner.get_by_test_id("driver-control")).to_be_visible(timeout=15_000)
        owner_control = owner.get_by_test_id("driver-control")
        expect(owner_control).to_contain_text("No active driver", timeout=15_000)

        # The header and composer consume the same authoritative coordination
        # cache. Pin their initial agreement before exercising mutations so a
        # regression cannot leave one surface showing stale ownership.
        owner.get_by_test_id("coordination-status-trigger").click()
        owner_status = owner.get_by_test_id("coordination-status-popover")
        expect(owner_status).to_contain_text("No active driver")
        expect(
            owner_status.get_by_test_id(f"coordination-participant-{ADMIN_EMAIL}")
        ).to_be_visible()
        expect(
            owner_status.get_by_test_id(f"coordination-participant-{collaborator_email}")
        ).to_be_visible()
        owner.keyboard.press("Escape")

        take_control = owner.get_by_role("button", name="Take control")
        take_control.focus()
        with owner.expect_response(
            lambda response: (
                response.url.endswith(f"/v1/sessions/{session_id}/driver/acquire")
                and response.request.method == "POST"
            )
        ) as acquire_response:
            owner.keyboard.press("Enter")
        assert acquire_response.value.status == 200
        expect(owner_control.get_by_role("status")).to_contain_text("You now have control")
        expect(owner.get_by_test_id("coordination-status-trigger")).to_have_attribute(
            "aria-label", re.compile(rf"{re.escape(ADMIN_EMAIL)} is driver")
        )

        target = owner.get_by_role("combobox", name="Transfer control to")
        target.click()
        owner.get_by_role("option", name=collaborator_email).click()
        transfer = owner.get_by_role("button", name="Transfer", exact=True)
        transfer.focus()
        owner.keyboard.press("Enter")

        confirmation = owner.get_by_role("dialog", name="Transfer session control?")
        expect(confirmation).to_contain_text("Control transfers immediately")
        expect(confirmation).to_contain_text(collaborator_email)
        confirm_transfer = confirmation.get_by_role("button", name="Transfer control")
        confirm_transfer.focus()
        with owner.expect_response(
            lambda response: (
                response.url.endswith(f"/v1/sessions/{session_id}/driver/handoff")
                and response.request.method == "POST"
            )
        ) as handoff_response:
            owner.keyboard.press("Enter")
        assert handoff_response.value.status == 200
        expect(owner_control.get_by_role("status")).to_contain_text(
            f"Control transferred to {collaborator_email}"
        )
        collaborator_control = collaborator.get_by_test_id("driver-control")
        expect(collaborator_control).to_contain_text("You have control", timeout=15_000)
        for page in (owner, collaborator):
            expect(page.get_by_test_id("coordination-status-trigger")).to_have_attribute(
                "aria-label",
                re.compile(rf"{re.escape(collaborator_email)} is driver"),
                timeout=15_000,
            )

        release = collaborator.get_by_role("button", name="Release control")
        release.focus()
        collaborator.keyboard.press("Enter")
        release_dialog = collaborator.get_by_role("dialog", name="Release session control?")
        expect(release_dialog).to_contain_text(
            "The session will have no active driver until an editor takes control"
        )
        confirm_release = release_dialog.get_by_role("button", name="Release control")
        confirm_release.focus()
        with collaborator.expect_response(
            lambda response: (
                response.url.endswith(f"/v1/sessions/{session_id}/driver/release")
                and response.request.method == "POST"
            )
        ) as release_response:
            collaborator.keyboard.press("Enter")
        assert release_response.value.status == 200
        expect(collaborator_control.get_by_role("status")).to_contain_text("Control released")
        expect(owner_control).to_contain_text("No active driver", timeout=15_000)
        for page in (owner, collaborator):
            expect(page.get_by_test_id("coordination-status-trigger")).to_have_attribute(
                "aria-label", re.compile("no active driver"), timeout=15_000
            )

        # Lease mutations are also persisted as a server-authoritative audit
        # trail. Opening the dialog after all three actions verifies the UI/API
        # projection and latest-first ordering through the real store.
        owner.get_by_role("button", name="Activity history").click()
        activity = owner.get_by_role("dialog", name="Coordination activity")
        rows = activity.get_by_role("list", name="Coordination activity").get_by_role("listitem")
        expect(rows).to_have_count(3, timeout=15_000)
        expect(rows.nth(0)).to_contain_text(f"{collaborator_email} released control")
        expect(rows.nth(1)).to_contain_text(
            f"{ADMIN_EMAIL} handed control to {collaborator_email}"
        )
        expect(rows.nth(2)).to_contain_text(f"{ADMIN_EMAIL} took control")
    finally:
        owner_context.close()
        collaborator_context.close()
