const test = require("node:test");
const assert = require("node:assert/strict");
const { registerTranscriptionHandlers } = require("../src/helpers/transcriptionHandlers");

test("desktop composition routes both cloud transcription paths through Electron networking", async () => {
  const requests = [];
  const net = {
    fetch: async (url) => {
      requests.push(url);
      return url;
    },
  };
  const registrations = {
    registerMeetingHandlers: ({ cloudFetch }) => ({
      readCloudKey: () => "synthetic-key",
      request: () => cloudFetch("meeting-request"),
    }),
    registerCaptureHandlers: ({ cloudFetch, readCloudKey }) => ({
      request: () => cloudFetch(`capture-request:${readCloudKey()}`),
    }),
  };
  const { meetings, captures } = registerTranscriptionHandlers({ net }, registrations);

  assert.equal(await meetings.request(), "meeting-request");
  assert.equal(await captures.request(), "capture-request:synthetic-key");
  assert.deepEqual(requests, ["meeting-request", "capture-request:synthetic-key"]);
});
