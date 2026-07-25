import { describe, expect, it, vi } from "vitest";

import type { ValidatedActivity } from "../src/activity.js";
import {
  respondToPersonalCommand,
  type TeamsAppServices,
} from "../src/app.js";
import type { EntraPrincipal } from "../src/identity.js";

const principal: EntraPrincipal = {
  objectId: "33333333-3333-4333-8333-333333333333",
  tenantId: "22222222-2222-4222-8222-222222222222",
};
const activity: ValidatedActivity = {
  activity: {} as ValidatedActivity["activity"],
  activityId: "activity-1",
  botAppId: "11111111-1111-4111-8111-111111111111",
  channelSenderId: "teams-sender",
  conversationId: "conversation-1",
  ok: true,
  senderId: principal.objectId,
  tenantId: principal.tenantId,
};
const config = { ssoConnectionName: "teams-sso" };

function services(overrides: Record<string, unknown> = {}): TeamsAppServices {
  return {
    identityValidator: {
      validate: vi.fn().mockResolvedValue(principal),
    },
    lifecycle: {
      connect: vi.fn().mockResolvedValue({
        completion: Promise.resolve("Omnigent account connected."),
        message: "Open https://omnigent.example/device and enter code TEST-CODE.",
      }),
      logout: vi.fn().mockReturnValue("disconnected"),
      status: vi.fn().mockReturnValue("connected"),
      ...overrides,
    },
  } as unknown as TeamsAppServices;
}

function signin(token: string | undefined = "validated-sso-token") {
  return vi.fn().mockResolvedValue(token);
}

describe("Teams personal grant commands", () => {
  it("requires SSO and binds status to the validated principal", async () => {
    const testServices = services();
    const signIn = signin();

    await expect(respondToPersonalCommand(
      signIn,
      vi.fn(),
      activity,
      "status",
      config,
      testServices,
    )).resolves.toBe("connected");

    expect(signIn).toHaveBeenCalledWith({ connectionName: "teams-sso" });
    expect(testServices.identityValidator.validate).toHaveBeenCalledWith("validated-sso-token", activity);
    expect(testServices.lifecycle.status).toHaveBeenCalledWith(principal);
  });

  it("fails closed when SSO identity validation fails", async () => {
    const testServices = services();
    vi.mocked(testServices.identityValidator.validate).mockRejectedValue(new Error("token marker must not escape"));

    await expect(respondToPersonalCommand(
      signin(),
      vi.fn(),
      activity,
      "logout",
      config,
      testServices,
    )).resolves.toBe("Microsoft sign-in could not be verified for this Teams account.");
    expect(testServices.lifecycle.logout).not.toHaveBeenCalled();
  });

  it("does not start account work before Teams sign-in completes", async () => {
    const testServices = services();

    await expect(respondToPersonalCommand(
      vi.fn().mockResolvedValue(undefined),
      vi.fn(),
      activity,
      "connect",
      config,
      testServices,
    )).resolves.toBe("Complete Microsoft sign-in, then send the command again.");
    expect(testServices.identityValidator.validate).not.toHaveBeenCalled();
    expect(testServices.lifecycle.connect).not.toHaveBeenCalled();
  });

  it("starts device authorization and sends its eventual bounded completion", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const testServices = services();

    await expect(respondToPersonalCommand(
      signin(),
      reply,
      activity,
      "connect",
      config,
      testServices,
    )).resolves.toContain("https://omnigent.example/device");
    await new Promise((resolve) => setImmediate(resolve));

    expect(testServices.lifecycle.connect).toHaveBeenCalledWith(principal);
    expect(reply).toHaveBeenCalledWith("Omnigent account connected.");
  });

  it("keeps unsupported commands outside the SSO and grant paths", async () => {
    const signIn = signin();
    const testServices = services();

    await expect(respondToPersonalCommand(
      signIn,
      vi.fn(),
      activity,
      "new",
      config,
      testServices,
    )).resolves.toContain("Unknown command");
    expect(signIn).not.toHaveBeenCalled();
  });
});
