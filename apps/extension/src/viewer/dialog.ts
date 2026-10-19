/**
 * 뷰어 안 모달 대화상자(저장 전 확인·중단 안내). 네이티브 `window.confirm` 은 임베디드 문맥(`<embed>`·`<iframe>`)에서
 * 막힐 수 있어 `<dialog>` 를 쓴다. 호출은 Promise 로 선택한 버튼 id 를 돌려준다(Esc·바깥은 'cancel').
 */
export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
}

export interface DialogOptions {
  title: string;
  /** 본문 단락(각각 `<p>`). */
  lines: string[];
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

/** 확인 창. 확인을 누르면 true. */
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

/** 안내 창(확인 버튼 하나). */
export async function alertDialog(
  dialog: HTMLDialogElement,
  title: string,
  lines: string[],
): Promise<void> {
  await openDialog(dialog, {
    title,
    lines,
    buttons: [{ id: 'ok', label: '확인', primary: true }],
  });
}
