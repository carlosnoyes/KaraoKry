// Modal dialogs built on <dialog>: confirmations, menus and info sheets.
// Android's back gesture closes an open dialog (it resolves as cancelled).

const open = new Set();
let nextId = 1;

/**
 * Opens a dialog and resolves with the chosen action's value, or null when dismissed.
 * @param {{title?: string, body?: string, variant?: 'dialog'|'sheet',
 *          actions: {label: string, value: any, kind?: 'primary'|'danger'|'secondary'|'plain'|'menu'|'menu-danger'}[]}} options
 *   Paragraphs in `body` are separated by a blank line.
 */
export function showDialog({ title, body, actions, variant = 'dialog' }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = `dialog dialog--${variant}`;

    const panel = document.createElement('div');
    panel.className = 'dialog__panel';
    if (title) {
      const heading = document.createElement('h2');
      heading.className = 'dialog__title';
      heading.id = `dialog-title-${nextId++}`;
      heading.textContent = title;
      dialog.setAttribute('aria-labelledby', heading.id);
      panel.append(heading);
    }
    if (body) {
      for (const paragraph of String(body).split('\n\n')) {
        const p = document.createElement('p');
        p.className = 'dialog__body';
        p.textContent = paragraph;
        panel.append(p);
      }
    }
    const row = document.createElement('div');
    row.className = 'dialog__actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn btn--${action.kind ?? 'secondary'}`;
      button.textContent = action.label;
      button.addEventListener('click', () => finish(action.value));
      row.append(button);
    }
    panel.append(row);
    dialog.append(panel);

    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      open.delete(dialog);
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    }
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener('close', () => finish(null));
    // A tap on the backdrop (outside the panel) dismisses the dialog.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(null);
    });
    dialog.closeDialog = () => finish(null);

    document.body.append(dialog);
    open.add(dialog);
    dialog.showModal();
    const first = row.querySelector('.btn--primary, .btn--danger') ?? row.querySelector('button');
    first?.focus({ preventScroll: true });
  });
}

/** Yes/no question. Resolves true only when confirmed. */
export async function confirmDialog({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  const value = await showDialog({
    title,
    body,
    actions: [
      { label: cancelLabel, value: false, kind: 'secondary' },
      { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return value === true;
}

/** A simple message with one button. */
export async function infoDialog({ title, body, okLabel = 'OK' }) {
  await showDialog({ title, body, actions: [{ label: okLabel, value: true, kind: 'primary' }] });
}

/**
 * A bottom-sheet menu.
 * @param {{label: string, value: any, danger?: boolean}[]} items
 */
export function menuSheet(items, { title } = {}) {
  return showDialog({
    title,
    variant: 'sheet',
    actions: [
      ...items.map((item) => ({ label: item.label, value: item.value, kind: item.danger ? 'menu-danger' : 'menu' })),
      { label: 'Close', value: null, kind: 'plain' },
    ],
  });
}

/** Closes the top-most open dialog. Returns true if one was open. */
export function closeTopDialog() {
  const dialogs = [...open];
  const top = dialogs[dialogs.length - 1];
  if (!top) return false;
  top.closeDialog();
  return true;
}

export function isDialogOpen() {
  return open.size > 0;
}
