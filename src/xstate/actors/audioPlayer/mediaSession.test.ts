import { describe, expect, it } from 'vitest';

import { shouldToggleForMediaSessionAction } from './mediaSession';

const audio = (paused: boolean) => ({ paused } as HTMLAudioElement);

describe('shouldToggleForMediaSessionAction', () => {
  it('toggles on "pause" only while the audio is playing', () => {
    expect(shouldToggleForMediaSessionAction('pause', audio(false))).toBe(true);
    // e.g. AirPods taken out after the tab already auto-paused: must not start playback
    expect(shouldToggleForMediaSessionAction('pause', audio(true))).toBe(false);
  });

  it('toggles on "play" only while the audio is paused', () => {
    expect(shouldToggleForMediaSessionAction('play', audio(true))).toBe(true);
    expect(shouldToggleForMediaSessionAction('play', audio(false))).toBe(false);
  });

  it('keeps the previous behavior when the audio element is unknown', () => {
    expect(shouldToggleForMediaSessionAction('play', null)).toBe(true);
    expect(shouldToggleForMediaSessionAction('pause', undefined)).toBe(true);
  });
});
