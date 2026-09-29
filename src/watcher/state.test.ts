import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { watcherStatus, selfChatJid, noteSelfChatJid, isSelfChatJid, resetSelfChatJid } from "./state.js";

beforeEach(() => {
  resetSelfChatJid();
  watcherStatus.selfJid = "15551234567@s.whatsapp.net";
  watcherStatus.selfLid = null;
});

test("falls back to PN jid without LID", () => {
  assert.equal(selfChatJid(), "15551234567@s.whatsapp.net");
});

test("strips device suffix from LID", () => {
  watcherStatus.selfLid = "123:45@lid";
  assert.equal(selfChatJid(), "123@lid");
});

test("prefers the jid the last self message arrived on", () => {
  watcherStatus.selfLid = "123:45@lid";
  noteSelfChatJid("15551234567:7@s.whatsapp.net");
  assert.equal(selfChatJid(), "15551234567@s.whatsapp.net");
  noteSelfChatJid("123@lid");
  assert.equal(selfChatJid(), "123@lid");
});

test("isSelfChatJid matches PN and LID aliases", () => {
  watcherStatus.selfLid = "123:45@lid";
  assert.ok(isSelfChatJid("123@lid"));
  assert.ok(isSelfChatJid("15551234567@s.whatsapp.net"));
  assert.ok(!isSelfChatJid("999@s.whatsapp.net"));
});
