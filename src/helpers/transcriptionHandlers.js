const { registerMeetingHandlers } = require("./meetingHandlers");
const { registerCaptureHandlers } = require("./captureHandlers");

function registerTranscriptionHandlers(
  { net, ...dependencies },
  registrations = { registerMeetingHandlers, registerCaptureHandlers }
) {
  if (!net || typeof net.fetch !== "function")
    throw new Error("Electron desktop network transport is unavailable");
  const cloudFetch = (...args) => net.fetch(...args);
  const meetings = registrations.registerMeetingHandlers({ ...dependencies, cloudFetch });
  const captures = registrations.registerCaptureHandlers({
    ...dependencies,
    readCloudKey: meetings.readCloudKey,
    cloudFetch,
  });
  return { meetings, captures };
}

module.exports = { registerTranscriptionHandlers };
