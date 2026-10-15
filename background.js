/**
 * StealthWriter Sessions v1.0 - background
 *
 * Opens the session manager when the in-page badge is clicked.
 *
 * NOTE ON action.openPopup():
 *   In stable Firefox this API may only be called from inside the handler for a
 *   user action. A runtime message arriving from a content script does NOT count
 *   as a user action in this context, so openPopup() is expected to reject here.
 *   That is why the windows.create() fallback below exists - it is the path that
 *   actually runs on Firefox, not a rare edge case.
 */

const POPUP_W = 360;
const POPUP_H = 560;

function openManagerWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: POPUP_W,
    height: POPUP_H
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  // Anything at all can be sent here, including undefined, and a worker that
  // throws while dispatching a message drops the rest of the listeners with
  // it.
  if (!msg || msg.type !== 'SW_OPEN_POPUP') return;

  // Try the real toolbar popup first (works on Chrome, and on Firefox if the
  // gesture requirement is ever relaxed). Fall back to a standalone window.
  let attempt;
  try {
    attempt = chrome.action.openPopup();
  } catch (e) {
    openManagerWindow();
    return;
  }

  if (attempt && typeof attempt.then === 'function') {
    attempt.catch(() => openManagerWindow());
  } else {
    // No promise returned - we cannot detect failure, so open the window.
    openManagerWindow();
  }
});
