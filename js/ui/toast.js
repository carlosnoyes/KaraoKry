// Short, non-blocking messages at the bottom of the screen.

const DEFAULT_MS = 2600;
let container = null;

function host() {
  if (!container) {
    container = document.getElementById('toasts');
  }
  return container;
}

/**
 * Shows a toast.
 * @param {string} message
 * @param {{ms?: number, sticky?: boolean, action?: {label: string, onClick: () => void}, id?: string}} [options]
 *   With `id`, an existing toast with the same id is replaced instead of stacking.
 * @returns {{dismiss: () => void}}
 */
export function toast(message, { ms = DEFAULT_MS, sticky = false, action, id } = {}) {
  const root = host();
  if (id) root.querySelector(`[data-toast-id="${id}"]`)?.remove();

  const el = document.createElement(action ? 'button' : 'div');
  el.className = 'toast';
  if (action) {
    el.type = 'button';
    el.classList.add('toast--action');
  }
  if (id) el.dataset.toastId = id;
  el.textContent = message;
  if (action?.label) {
    const label = document.createElement('span');
    label.className = 'toast__action';
    label.textContent = action.label;
    el.append(label);
  }

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    el.addEventListener('click', () => {
      dismiss();
      action.onClick();
    });
  }
  root.append(el);
  if (!sticky) timer = setTimeout(dismiss, ms);
  return { dismiss };
}

export function dismissToast(id) {
  host()?.querySelector(`[data-toast-id="${id}"]`)?.remove();
}
