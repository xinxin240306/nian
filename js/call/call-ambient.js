/** 连麦环境音：按角色当前活动拉取，无缝循环、小声可闻 */

import * as api from '../api.js';
import {
  playHangoutBed,
  playHangoutBedProcedural,
  stopHangoutBed,
  duckCallAmbient,
  setHangoutBedListenQuiet,
} from '../tts.js';
import { getState, isHangout, isHangoutSleeping } from './call-state.js';

let _bedToken = 0;

const SLEEP_BED = {
  kind: 'room',
  volume: 0.06,
  procedural: 'room',
};

export async function startHangoutAmbient(deps) {
  const token = ++_bedToken;
  const st = getState();
  if (!isHangout() || !st.callCharId) return;

  if (isHangoutSleeping()) {
    playHangoutBedProcedural(SLEEP_BED.procedural, { volume: SLEEP_BED.volume });
    syncAmbientDuck();
    return;
  }

  let bed = null;
  try {
    bed = await api.fetchHangoutBed(st.callCharId);
  } catch (e) {
    console.warn('[call] hangout bed', e?.message || e);
  }
  if (token !== _bedToken || !isHangout()) return;

  if (bed?.charAsleep != null || bed?.activity != null) {
    deps?.onCharPresence?.({
      asleep: !!bed.charAsleep,
      activity: String(bed.activity || ''),
    });
  }

  const vol = Math.max(0.06, Math.min(0.16, Number(bed?.volume) || 0.09));
  if (bed?.url) {
    playHangoutBed(bed.url, { volume: vol, procedural: bed.kind || bed.procedural });
  } else {
    playHangoutBedProcedural(bed?.procedural || bed?.kind || 'keyboard', { volume: vol });
  }
  syncAmbientDuck();
}

export function stopHangoutAmbient() {
  _bedToken += 1;
  stopHangoutBed();
}

export function syncAmbientDuck() {
  const st = getState();
  const onCall = st.inCall && !st.callDialing;
  // 角色开口不影响环境音；仅开麦听人时略压连麦垫音，避免当人声
  try { duckCallAmbient(false); } catch {}
  try {
    setHangoutBedListenQuiet(onCall && isHangout() && !st.speaking && !!st.voiceMode);
  } catch {}
}

export function refreshAmbientForSleepChange(deps) {
  if (!isHangout()) return;
  void startHangoutAmbient(deps);
}
