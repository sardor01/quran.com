import { useEffect } from 'react';

import { InterpreterFrom } from 'xstate';

import { logEvent } from '@/utils/eventLogger';
import { audioPlayerMachine } from 'src/xstate/actors/audioPlayer/audioPlayerMachine';
import { MEDIA_SESSION_PAUSE_EVENT } from 'src/xstate/actors/audioPlayer/mediaSession';

type AudioService = InterpreterFrom<typeof audioPlayerMachine>;

const PLAYING = 'VISIBLE.AUDIO_PLAYER_INITIATED.PLAYING';
const PLAYING_ACTIVE = 'VISIBLE.AUDIO_PLAYER_INITIATED.PLAYING.ACTIVE';
const PAUSED_ACTIVE = 'VISIBLE.AUDIO_PLAYER_INITIATED.PAUSED.ACTIVE';
// The gap between verse repetitions; playback starts again by itself when it ends.
const DELAYING = 'VISIBLE.AUDIO_PLAYER_INITIATED.DELAYING';

const pausePlayback = (audioService: AudioService) => {
  const snapshot = audioService.getSnapshot();
  if (snapshot.matches(PLAYING_ACTIVE)) {
    // Same as the user clicking the pause button.
    audioService.send('TOGGLE');
  } else {
    // Buffering (PLAYING.LOADING) doesn't handle TOGGLE; pausing the element sends PAUSE.
    snapshot.context.audioPlayer?.pause();
  }
  logEvent('audio_player_auto_paused_tab_hidden');
};

/**
 * @param {AudioService} audioService the audio player machine service
 * @returns {{ wasAutoPaused: boolean, shouldPauseWhenPlaybackStarts: boolean }} what was done
 */
const onTabHidden = (audioService: AudioService) => {
  const snapshot = audioService.getSnapshot();
  if (snapshot.matches(PLAYING)) {
    pausePlayback(audioService);
    return { wasAutoPaused: true, shouldPauseWhenPlaybackStarts: false };
  }
  // A verse-repeat delay would start playing again in the background once it ends.
  return { wasAutoPaused: false, shouldPauseWhenPlaybackStarts: snapshot.matches(DELAYING) };
};

const resumeAutoPausedPlayback = (audioService: AudioService) => {
  // Don't resume if something else happened meanwhile (the user played/paused, the surah ended).
  if (!audioService.getSnapshot().matches(PAUSED_ACTIVE)) return;
  audioService.send('TOGGLE');
  logEvent('audio_player_auto_resumed_tab_visible');
};

/**
 * Pause the audio when the tab is hidden (switched tab, minimized window, locked phone) and resume
 * it when the tab is visible again, but only if it was this hook that paused it.
 *
 * Only the moment the tab becomes hidden counts: if the user starts playback again while the tab
 * is hidden (e.g. with the OS media controls), it keeps playing. And if they send a pause command
 * while away (e.g. taking AirPods out), it isn't resumed on return.
 *
 * @param {AudioService} audioService the audio player machine service
 */
const usePauseAudioWhenTabHidden = (audioService: AudioService) => {
  useEffect(() => {
    let wasAutoPaused = false;
    let shouldPauseWhenPlaybackStarts = false;
    let wasPauseRequestedWhileHidden = false;

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        wasPauseRequestedWhileHidden = false;
        ({ wasAutoPaused, shouldPauseWhenPlaybackStarts } = onTabHidden(audioService));
        return;
      }
      shouldPauseWhenPlaybackStarts = false;
      if (wasAutoPaused && !wasPauseRequestedWhileHidden) resumeAutoPausedPlayback(audioService);
      wasAutoPaused = false;
    };
    const onMediaSessionPause = () => {
      wasPauseRequestedWhileHidden = true;
    };

    const subscription = audioService.subscribe((state) => {
      if (!shouldPauseWhenPlaybackStarts || !state.matches(PLAYING_ACTIVE)) return;
      shouldPauseWhenPlaybackStarts = false;
      wasAutoPaused = true;
      // Let the current transition finish before sending the next event.
      setTimeout(() => pausePlayback(audioService), 0);
    });

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener(MEDIA_SESSION_PAUSE_EVENT, onMediaSessionPause);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener(MEDIA_SESSION_PAUSE_EVENT, onMediaSessionPause);
      subscription.unsubscribe();
    };
  }, [audioService]);
};

export default usePauseAudioWhenTabHidden;
