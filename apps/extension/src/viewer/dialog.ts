/**
 * In-viewer modal dialog (pre-save confirmation, abort notice). The native `window.confirm` can be blocked in embedded contexts (`<embed>`, `<iframe>`),
 * so `<dialog>` is used. The call returns the id of the chosen button as a Promise (Esc or clicking outside gives 'cancel').
 */
export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
}

export interface DialogLink {
  label: string;
  href: string;
}

export interface DialogOptions {
  title: string;
  /** Body paragraphs (each a `<p>`). */
  lines: string[];
  /** Links listed after the body (opened in a new tab). */
  links?: DialogLink[];
  buttons: DialogButton[];
}

export function openDialog(dialog: HTMLDialogElement, options: DialogOptions): Promise<string> {
  return new Promise((resolve) => {
    dialog.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = options.title;
    const body = document.createElement('div');
    body.className = 'dialog-body';
    for (const line of options.lines) {
      const p = document.createElement('p');
      p.textContent = line;
      body.append(p);
    }
    for (const link of options.links ?? []) {
      const p = document.createElement('p');
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label;
      p.append(a);
      body.append(p);
    }
    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    let done = false;
    const finish = (id: string) => {
      if (done) return;
      done = true;
      dialog.close();
      resolve(id);
    };
    let primary: HTMLButtonElement | null = null;
    for (const b of options.buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = b.label;
      button.dataset.dialogButton = b.id;
      if (b.primary) primary = button;
      button.addEventListener('click', () => finish(b.id));
      actions.append(button);
    }
    dialog.addEventListener(
      'cancel',
      (e) => {
        e.preventDefault();
        finish('cancel');
      },
      { once: true },
    );
    dialog.append(title, body, actions);
    dialog.showModal();
    primary?.focus();
  });
}

/** Confirmation dialog. Resolves true when confirmed. */
export async function confirmDialog(
  dialog: HTMLDialogElement,
  title: string,
  lines: string[],
  okLabel = '계속',
  cancelLabel = '취소',
): Promise<boolean> {
  const id = await openDialog(dialog, {
    title,
    lines,
    buttons: [
      { id: 'cancel', label: cancelLabel },
      { id: 'ok', label: okLabel, primary: true },
    ],
  });
  return id === 'ok';
}

/** Notice dialog (a single OK button). */
export async function alertDialog(
  dialog: HTMLDialogElement,
  title: string,
  lines: string[],
  okLabel = '확인',
): Promise<void> {
  await openDialog(dialog, {
    title,
    lines,
    buttons: [{ id: 'ok', label: okLabel, primary: true }],
  });
}
