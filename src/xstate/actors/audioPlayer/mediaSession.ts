/**
 * Dispatched on `window` whenever a media session "pause" command arrives (media keys, headphones,
 * OS controls), even when it changes nothing, so other features can tell the user asked to pause.
 */
export const MEDIA_SESSION_PAUSE_EVENT = 'quran-audio:media-session-pause';

/**
 * Media keys, headphones (e.g. taking AirPods out or switching them to another device) and OS media
 * controls send explicit "play" or "pause" commands, but the audio player machine only has TOGGLE.
 * Toggling unconditionally makes a "pause" start playback when the audio is already paused (and a
 * "play" pause it), so only toggle when it moves playback in the requested direction.
 *
 * @param {'play' | 'pause'} action the media session action that was received
 * @param {HTMLAudioElement | null | undefined} audioPlayer the player's audio element
 * @returns {boolean} whether the machine should be sent TOGGLE
 */
export const shouldToggleForMediaSessionAction = (
  action: 'play' | 'pause',
  audioPlayer: HTMLAudioElement | null | undefined,
): boolean => {
  // Without the element we can't tell the current state; keep the previous behavior.
  if (!audioPlayer) return true;
  return action === 'play' ? audioPlayer.paused : !audioPlayer.paused;
};
