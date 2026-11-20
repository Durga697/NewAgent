import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { WebSocketServer } from "ws";

const provider = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await once(provider, "listening");
let setup,
  microphoneFrames = 0;
provider.on("connection", (ws) => {
  ws.on("message", (raw) => {
    const event = JSON.parse(raw);
    if (event.setup) {
      setup = event.setup;
      ws.send(JSON.stringify({ setupComplete: {} }));
    }
    if (event.realtimeInput?.audio || event.realtimeInput?.mediaChunks)
      microphoneFrames++;
    if (
      event.clientContent?.turns?.some((t) =>
        t.parts.some((p) => p.text === "Can you hear me?"),
      )
    ) {
      ws.send(
        JSON.stringify({
          serverContent: {
            outputTranscription: { text: "I received your message." },
            turnComplete: true,
          },
        }),
      );
    }
  });
});
const port = 3017,
  base = "http://localhost:" + port;
const server = spawn(process.execPath, ["server.mjs"], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    CALENDAR_FILE: ":memory:",
    GEMINI_API_KEY: "test-only",
    GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:" + provider.address().port,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Workspace server startup timeout")),
      15000,
    );
    server.stdout.on("data", (data) => {
      if (data.toString().includes("ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Server exited " + code));
    });
  });
  browser = await chromium.launch({
    channel: "msedge",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ["microphone"],
    reducedMotion: "reduce",
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let textSessionClosedByServer = false;
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/api/assistant/text")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string" && JSON.parse(payload).type === "closed")
        textSessionClosedByServer = true;
    });
  });
  await page.goto(base + "/app");
  await page.getByText("Configured", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/app");
  assert.equal(
    await page.getByRole("heading", { level: 1 }).innerText(),
    "Your day, a little easier.",
  );
  const urls = await page
    .locator("#side-nav a")
    .evaluateAll((items) => items.map((a) => a.pathname));
  assert.equal(urls.length, 17);
  for (const path of [
    ...urls,
    "/app/tasks/example",
    "/app/automations/example",
    "/app/conversations/example",
    "/app/knowledge/example",
  ]) {
    assert.equal((await context.request.get(base + path)).status(), 200);
  }
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
    for (const path of urls) {
      // Use real links inside the same app, keeping one cookie and one session.
      await page.keyboard.press("Control+k");
      const key = urls.indexOf(path);
      await page.locator("#palette-results a").nth(key).click();
      assert.equal(new URL(page.url()).pathname, path);
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        width + " overflow at " + path,
      );
    }
  }
  await page.goto(base + "/app/tasks/unknown");
  await page.getByText("Page or record unavailable").waitFor();
  await page.goto(base + "/app");
  await page.getByText("Configured", { exact: true }).waitFor();
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const violations = await page.evaluate(async () =>
      (
        await axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((v) => [v.id, v.nodes.map((n) => n.target)]),
    );
    assert.deepEqual(
      violations,
      [],
      width + "px accessibility: " + JSON.stringify(violations),
    );
  }
  if (process.argv.includes("--screenshots")) {
    await page.screenshot({ path: "docs/screenshots/edith-os-home.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "docs/screenshots/edith-os-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 960 });
  }
  await page.locator("#message").fill("Can you hear me?");
  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .locator("#dialogue")
    .getByText("I received your message.")
    .waitFor();
  assert(!setup.tools);
  assert.equal(microphoneFrames, 0);
  await page.getByRole("button", { name: "End session" }).click();
  await page.getByRole("button", { name: "Talk to Edith" }).click();
  await page.locator("#orb-status").getByText("Listening").waitFor();
  assert(textSessionClosedByServer, "The server released text mode before voice started");
  assert(!setup.tools, "No tools should be advertised when file access is disabled");
  const until = Date.now() + 3000;
  while (!microphoneFrames && Date.now() < until)
    await new Promise((r) => setTimeout(r, 30));
  assert(microphoneFrames > 0);
  await page.getByRole("button", { name: "Mute mic" }).click();
  await page.locator("#mic-status").getByText("Muted").waitFor();
  await page
    .locator("#side-nav")
    .getByRole("link", { name: "Voice Studio" })
    .click();
  await page.getByRole("button", { name: "End session" }).click();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Denied", "NotAllowedError");
    };
  });
  await page.getByRole("button", { name: "Talk to Edith" }).click();
  await page
    .getByRole("alert")
    .getByText(/permission was denied/)
    .waitFor();
  await page.locator("#message").fill("Help");
  await page.locator("#composer").press("Enter");
  await page.waitForURL("**/app/help");
  await page.goBack();
  assert.equal(new URL(page.url()).pathname, "/app/voice");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: 17 routes at five widths, record deep links, command palette, browser history, automated WCAG A/AA home checks, typed Gemini transport, no microphone in text mode, voice capture, scoped tools, mute, session navigation, end and microphone denial.",
  );
} finally {
  await browser?.close();
  server.kill();
  for (const ws of provider.clients) ws.terminate();
  await new Promise((r) => provider.close(r));
}
