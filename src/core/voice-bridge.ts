import { isLinuxHost } from "./platform-info";
import {
  cancelCapture,
  isCaptureSupported,
  startCapture,
  stopCaptureAndTranscribe,
} from "./voice-capture";

/**
 * Two ways to reach a microphone. The main process spawns `parecord`, which is
 * PulseAudio and exists on Linux alone: on Windows and macOS there is nothing
 * to spawn, so Chromium records in the renderer instead (macOS asks for the
 * microphone through the system prompt the first time). The choice is made
 * here so callers never learn about it.
 */
export function recordsInRenderer(): boolean {
  return !isLinuxHost() && isCaptureSupported();
}

export async function startVoiceRecording(): Promise<void> {
  if (recordsInRenderer()) {
    await startCapture();
    return;
  }
  await window.headTerminal.voice.start();
}

export async function stopAndTranscribeVoice(_apiKey?: string): Promise<string> {
  if (recordsInRenderer()) {
    return stopCaptureAndTranscribe();
  }
  return window.headTerminal.voice.stopAndTranscribe();
}

export async function cancelVoiceRecording(): Promise<void> {
  if (recordsInRenderer()) {
    cancelCapture();
    return;
  }
  await window.headTerminal.voice.cancel();
}
