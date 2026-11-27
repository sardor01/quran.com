/* eslint-disable react-func/max-lines-per-function */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import usePauseAudioWhenTabHidden from './usePauseAudioWhenTabHidden';

import { MEDIA_SESSION_PAUSE_EVENT } from 'src/xstate/actors/audioPlayer/mediaSession';

vi.mock('@/utils/eventLogger', () => ({ logEvent: vi.fn() }));

const PLAYING_ACTIVE = 'VISIBLE.AUDIO_PLAYER_INITIATED.PLAYING.ACTIVE';
const PLAYING_LOADING = 'VISIBLE.AUDIO_PLAYER_INITIATED.PLAYING.LOADING';
const PAUSED_ACTIVE = 'VISIBLE.AUDIO_PLAYER_INITIATED.PAUSED.ACTIVE';
const DELAYING = 'VISIBLE.AUDIO_PLAYER_INITIATED.DELAYING';

const makeState = (value: string) => ({
  // xstate's matches() also matches parent states, e.g. PLAYING for PLAYING.ACTIVE
  matches: (query: string) => value === query || value.startsWith(`${query}.`),
});

/**
 * A minimal stand-in for the audio player machine service.
 *
 * @param {string} initialState the state the fake machine starts in
 * @returns {object} the fake service plus helpers to drive it
 */
const createFakeService = (initialState: string) => {
  let current = initialState;
  let listener: ((state: ReturnType<typeof makeState>) => void) | null = null;
  const audioPlayer = { pause: vi.fn() };
  const service = {
    getSnapshot: () => ({ ...makeState(current), context: { audioPlayer } }),
    send: vi.fn(),
    subscribe: vi.fn((fn) => {
      listener = fn;
      return { unsubscribe: vi.fn() };
    }),
  };
  const setState = (value: string) => {
    current = value;
    listener?.(makeState(value));
  };
  return { service, audioPlayer, setState };
};

let visibilityState: DocumentVisibilityState = 'visible';
const setVisibility = (value: DocumentVisibilityState) => {
  visibilityState = value;
  document.dispatchEvent(new Event('visibilitychange'));
};

const renderWith = (service: unknown) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderHook(() => usePauseAudioWhenTabHidden(service as any));

describe('usePauseAudioWhenTabHidden', () => {
  beforeEach(() => {
    visibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityState,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses playing audio when the tab is hidden and resumes it when visible again', () => {
    const { service, setState } = createFakeService(PLAYING_ACTIVE);
    renderWith(service);

    setVisibility('hidden');
    expect(service.send).toHaveBeenCalledWith('TOGGLE');

    setState(PAUSED_ACTIVE);
    service.send.mockClear();
    setVisibility('visible');
    expect(service.send).toHaveBeenCalledWith('TOGGLE');
  });

  it('pauses the audio element directly while buffering', () => {
    const { service, audioPlayer } = createFakeService(PLAYING_LOADING);
    renderWith(service);

    setVisibility('hidden');
    expect(audioPlayer.pause).toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
  });

  it('does nothing when the user had already paused the audio', () => {
    const { service, audioPlayer } = createFakeService(PAUSED_ACTIVE);
    renderWith(service);

    setVisibility('hidden');
    setVisibility('visible');
    expect(service.send).not.toHaveBeenCalled();
    expect(audioPlayer.pause).not.toHaveBeenCalled();
  });

  it('does not toggle again if the user resumed playback while the tab was hidden', () => {
    const { service, setState } = createFakeService(PLAYING_ACTIVE);
    renderWith(service);

    setVisibility('hidden');
    setState(PLAYING_ACTIVE); // e.g. played again with the OS media controls
    service.send.mockClear();
    setVisibility('visible');
    expect(service.send).not.toHaveBeenCalled();
  });

  it('does not resume if a media "pause" command arrived while the tab was hidden', () => {
    const { service, setState } = createFakeService(PLAYING_ACTIVE);
    renderWith(service);

    setVisibility('hidden');
    setState(PAUSED_ACTIVE);
    window.dispatchEvent(new Event(MEDIA_SESSION_PAUSE_EVENT)); // e.g. AirPods taken out
    service.send.mockClear();
    setVisibility('visible');
    expect(service.send).not.toHaveBeenCalled();

    // The next time the tab is hidden, auto-pause/resume works again.
    setState(PLAYING_ACTIVE);
    setVisibility('hidden');
    setState(PAUSED_ACTIVE);
    service.send.mockClear();
    setVisibility('visible');
    expect(service.send).toHaveBeenCalledWith('TOGGLE');
  });

  it('pauses once a verse-repeat delay ends while the tab is hidden', () => {
    vi.useFakeTimers();
    const { service, setState } = createFakeService(DELAYING);
    renderWith(service);

    setVisibility('hidden');
    expect(service.send).not.toHaveBeenCalled();

    setState(PLAYING_ACTIVE);
    vi.runAllTimers();
    expect(service.send).toHaveBeenCalledWith('TOGGLE');

    setState(PAUSED_ACTIVE);
    service.send.mockClear();
    setVisibility('visible');
    expect(service.send).toHaveBeenCalledWith('TOGGLE');
  });

  it('stops listening after unmount', () => {
    const { service } = createFakeService(PLAYING_ACTIVE);
    const { unmount } = renderWith(service);
    unmount();

    setVisibility('hidden');
    expect(service.send).not.toHaveBeenCalled();
  });
});
