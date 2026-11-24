import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { aiPayload, requestReflection } from "../src/reflection.js";

const ai = {
  endpoint: "https://models.example/v1",
  model: "example",
  secret: "model-reference",
  lang: "auto",
  fields: ["tasks", "habits"],
};
const facts = {
  tasks: [" Write the outline ", 3, ""],
  projects: ["Private project"],
  habits: ["Stretch"],
  journal: ["private journal"],
  finance: ["private finance"],
  media: ["private creator account"],
};
test("only authorized fields enter the exact Chat Completions request body", () => {
  const payload = aiPayload(
    {
      ai: {
        ...ai,
        fields: [...ai.fields, "journal", "finance", "media", "secret"],
      },
    },
    "zh",
    facts,
  );
  assert.deepEqual(JSON.parse(payload.messages[1].content), {
    tasks: ["Write the outline"],
    habits: ["Stretch"],
  });
  assert.match(payload.messages[0].content, /Simplified Chinese/);
  assert.deepEqual(Object.keys(payload).sort(), [
    "messages",
    "model",
    "stream",
  ]);
  assert.doesNotMatch(JSON.stringify(payload), /private|model-reference/i);
  const denied = aiPayload({ ...ai, lang: "en", fields: [] }, "zh", facts);
  assert.match(denied.messages[0].content, /English/);
  assert.deepEqual(JSON.parse(denied.messages[1].content), {});
});

test("the preview limits each group and sends names as strings", () => {
  const payload = aiPayload(ai, "en", {
    tasks: Array(26).fill("x".repeat(450)),
    habits: [{ title: "unsafe shape" }],
  });
  const selected = JSON.parse(payload.messages[1].content);
  assert.equal(selected.tasks.length, 24);
  assert.equal(selected.tasks[0].length, 400);
  assert.deepEqual(selected.habits, []);
});

test("send the preview unchanged and reject provider redirects without exposing response data", async (t) => {
  const key = "fictional-key-for-contract-test";
  const body = aiPayload(ai, "en", facts);
  let status = 200;
  let calls = 0;
  const original = https.request;
  https.request = function (url, options, receive) {
    calls++;
    assert.equal(url, "https://models.example/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer " + key);
    const outgoing = new EventEmitter();
    outgoing.end = (posted) => {
      assert.equal(posted, JSON.stringify(body, null, 2));
      assert.equal(
        options.headers["Content-Length"],
        Buffer.byteLength(posted),
      );
      const response = new EventEmitter();
      response.statusCode = status;
      response.destroy = () => {};
      receive(response);
      if (status === 200) {
        response.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              choices: [
                { message: { content: "You set aside time to stretch." } },
              ],
            }),
          ),
        );
        response.emit("end");
      }
    };
    return outgoing;
  };
  syncBuiltinESMExports();
  t.after(() => {
    https.request = original;
    syncBuiltinESMExports();
  });
  const signal = new AbortController().signal;
  assert.equal(
    await requestReflection(ai, key, body, signal),
    "You set aside time to stretch.",
  );
  status = 302;
  await assert.rejects(
    requestReflection(ai, key, body, signal),
    /Redirects are disabled/,
  );
  assert.equal(calls, 2);
  for (const endpoint of [
    "http://models.example/v1",
    "https://user:password@models.example",
    "https://models.example/v1?api_key=private",
  ]) {
    await assert.rejects(
      requestReflection({ ...ai, endpoint }, key, body, signal),
      /HTTPS model URL/,
    );
  }
  await assert.rejects(
    requestReflection(ai, key, body, AbortSignal.abort()),
    /cancelled/,
  );
  assert.equal(calls, 2);
});
