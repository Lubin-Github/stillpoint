import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function createHarness() {
  let internals;
  let stateCells = [];
  let stateCursor = 0;
  let idCounter = 0;
  const pendingLayoutEffects = [];
  const layoutCleanups = [];
  const effectCleanups = [];

  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      const flat = [];
      const push = item => {
        if (Array.isArray(item)) item.forEach(push);
        else if (item !== null && item !== undefined && item !== false && item !== true) flat.push(item);
      };
      children.forEach(push);
      return { type, props: props ?? {}, children: flat };
    },
    useState(initial) {
      const idx = stateCursor++;
      if (!(idx in stateCells)) {
        stateCells[idx] = typeof initial === 'function' ? initial() : initial;
      }
      const set = next => {
        stateCells[idx] = typeof next === 'function' ? next(stateCells[idx]) : next;
      };
      return [stateCells[idx], set];
    },
    useRef(initial) {
      const idx = stateCursor++;
      if (!(idx in stateCells)) stateCells[idx] = { current: initial };
      return stateCells[idx];
    },
    useId() {
      const idx = stateCursor++;
      if (!(idx in stateCells)) stateCells[idx] = `:r${++idCounter}:`;
      return stateCells[idx];
    },
    useEffect(fn) {
      const idx = stateCursor++;
      if (!(idx in stateCells)) {
        stateCells[idx] = true;
        const cleanup = fn();
        if (typeof cleanup === 'function') effectCleanups.push(cleanup);
      }
    },
    useLayoutEffect(fn) {
      pendingLayoutEffects.push(fn);
    },
    useSyncExternalStore(_sub, getSnapshot) {
      return getSnapshot();
    },
  };

  const edited = source.replace(
    '    return {\n      inject: [\'slots\', \'locale\'],',
    '    expose({ en, zh, styles, EMPTY_OTP, applyOtpPaste, applyOtpChange, applyOtpKey, LockDialog, CleanupDialog });\n    return {\n      inject: [\'slots\', \'locale\'],',
  );
  const window = {
    __ModuleLoader__: { load: mod => mod.factory(name => (name === 'react' ? React : {})) },
    setTimeout,
    clearTimeout,
  };
  const document = { activeElement: null };
  runInNewContext(edited, {
    window,
    document,
    HTMLElement: class HTMLElement {},
    fetch: async () => ({ ok: false }),
    expose: value => { internals = value; },
  });

  function expand(node) {
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const nextProps = { ...node.props };
      if (node.children.length === 1) nextProps.children = node.children[0];
      else if (node.children.length > 1) nextProps.children = node.children;
      return expand(node.type(nextProps));
    }
    const expandedChildren = [];
    for (const child of node.children) {
      const out = expand(child);
      if (out?.type === React.Fragment) expandedChildren.push(...out.children);
      else if (out !== null && out !== undefined && out !== false && out !== true) expandedChildren.push(out);
    }
    const outNode = { type: node.type, props: node.props, children: expandedChildren };
    if (typeof node.props?.ref === 'function') node.props.ref(outNode);
    else if (node.props?.ref && typeof node.props.ref === 'object' && !node.props.ref.current) {
      node.props.ref.current = outNode;
    }
    return outNode;
  }

  function render(Component, props, beforeEffects) {
    stateCursor = 0;
    pendingLayoutEffects.length = 0;
    const tree = expand(React.createElement(Component, props));
    beforeEffects?.(tree);
    while (pendingLayoutEffects.length) {
      const cleanup = pendingLayoutEffects.shift()();
      if (typeof cleanup === 'function') layoutCleanups.push(cleanup);
    }
    return tree;
  }

  function reset() {
    while (layoutCleanups.length) layoutCleanups.pop()();
    while (effectCleanups.length) effectCleanups.pop()();
    stateCells = [];
    stateCursor = 0;
  }

  return { ...internals, render, reset };
}

function findAll(node, predicate, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (predicate(node)) acc.push(node);
  for (const child of node.children ?? []) findAll(child, predicate, acc);
  return acc;
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children ?? []).map(textOf).join(' ');
}

function bindDict(dict) {
  return (key, vars = {}) => String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

test('zh and en dictionaries define identical keys and lock screen opaque backdrop CSS', () => {
  const { en, zh, styles } = createHarness();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  assert.match(styles, /\.dsh-lock-gate-dialog::backdrop\s*\{[^}]*background-color:\s*#071522/);
  assert.doesNotMatch(styles, /\.dsh-lock-gate-dialog::backdrop\s*\{[^}]*background-color:\s*transparent/);
});

test('segmented OTP helpers handle typing, overwrite, paste, autofill, backspace, and navigation', () => {
  const { EMPTY_OTP, applyOtpChange, applyOtpPaste, applyOtpKey } = createHarness();

  let state = { digits: [...EMPTY_OTP], focusIndex: 0 };
  for (const [i, digit] of ['4', '8', '2', '9', '1', '6'].entries()) {
    state = applyOtpChange(state.digits, i, digit);
    assert.equal(state.focusIndex, Math.min(i + 1, 5));
  }
  assert.deepEqual([...state.digits], ['4', '8', '2', '9', '1', '6']);

  // Overwriting an already-filled slot (both different digit and identical digit) advances cleanly
  const replaced = applyOtpChange(state.digits, 2, '27');
  assert.equal(replaced.digits[2], '7');
  assert.equal(replaced.focusIndex, 3);
  const sameDigit = applyOtpChange(replaced.digits, 2, '77');
  assert.equal(sameDigit.digits[2], '7');
  assert.equal(sameDigit.focusIndex, 3);

  // Pasting formatted 6-digit code from any slot populates all 6 slots
  const pasted = applyOtpPaste([...EMPTY_OTP], 3, ' 593-041 ');
  assert.deepEqual([...pasted.digits], ['5', '9', '3', '0', '4', '1']);
  assert.equal(pasted.focusIndex, 5);

  // Partial paste from slot 2 fills from slot 2
  const partial = applyOtpPaste([...EMPTY_OTP], 2, 'ab84z');
  assert.deepEqual([...partial.digits], ['', '', '8', '4', '', '']);
  assert.equal(partial.focusIndex, 4);

  // Backspace on filled cell clears in place; Backspace on empty cell clears previous and moves left
  const backFilled = applyOtpKey(['1', '2', '3', '', '', ''], 2, 'Backspace');
  assert.deepEqual([...backFilled.digits], ['1', '2', '', '', '', '']);
  assert.equal(backFilled.focusIndex, 2);

  const backEmpty = applyOtpKey(backFilled.digits, 2, 'Backspace');
  assert.deepEqual([...backEmpty.digits], ['1', '', '', '', '', '']);
  assert.equal(backEmpty.focusIndex, 1);

  assert.equal(applyOtpKey(EMPTY_OTP, 0, 'ArrowRight').focusIndex, 1);
  assert.equal(applyOtpKey(EMPTY_OTP, 4, 'ArrowLeft').focusIndex, 3);
  assert.equal(applyOtpKey(EMPTY_OTP, 4, 'Home').focusIndex, 0);
  assert.equal(applyOtpKey(EMPTY_OTP, 1, 'End').focusIndex, 5);
  assert.equal(applyOtpKey(EMPTY_OTP, 1, 'Tab').handled, false);
});

test('LockDialog renders cover-matched structure, blocks Escape/bubbling, and leaks zero sensitive data', async () => {
  const h = createHarness();
  const t = bindDict(h.zh);
  const locale = { getSnapshot: () => ({ active: 'zh-CN' }) };
  const calls = [];
  let resolveUnlock;
  const service = {
    refresh: () => {},
    async post(action, payload) {
      calls.push({ action, payload });
      if (action === 'send') return { ok: payload.masterPassword === 'correct-master-password' };
      if (action === 'unlock') {
        return await new Promise(resolve => { resolveUnlock = resolve; });
      }
      return { ok: false };
    },
  };

  const passwordBox = {
    value: '',
    focused: false,
    focus() { this.focused = true; },
    reportValidity() { return this.value.length > 0; },
  };
  const otpBoxes = Array.from({ length: 6 }, () => ({
    focused: false,
    focus() { this.focused = true; },
    select() {},
    reportValidity() { return true; },
  }));
  const dialogEl = {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
  };

  function mount(draining = true) {
    let passInput;
    let cells;
    const tree = h.render(
      h.LockDialog,
      {
        t,
        locale,
        service,
        snapshot: { mode: 'locked', draining, pending: null, status: 'ready' },
      },
      rendered => {
        rendered.props.ref.current = dialogEl;
        passInput = findAll(rendered, n => n.type === 'input' && n.props.name === 'masterPassword')[0];
        passInput.props.ref.current = passwordBox;
        cells = findAll(rendered, n => n.type === 'input' && n.props.className === 'dsh-lock-otp-cell');
        cells.forEach((cell, i) => cell.props.ref(otpBoxes[i]));
      },
    );
    return { tree, passInput, cells };
  }

  const first = mount(true);
  const renderedText = textOf(first.tree);

  // Visual chrome + draining state present, zero sensitive schedule / recipient / agent count leakage
  assert.match(renderedText, /工作区已锁定/);
  assert.match(renderedText, /后台任务平稳收尾中/);
  assert.match(renderedText, /验证解锁/);
  assert.doesNotMatch(renderedText, /18:00|CRON|AGENT|@qq\.com|smtp/i);

  // Escape cancel blocked & key propagation isolated
  let canceled = false;
  first.tree.props.onCancel({ preventDefault() { canceled = true; } });
  assert.equal(canceled, true);
  let stoppedDown = false;
  let stoppedUp = false;
  first.tree.props.onKeyDown({ stopPropagation() { stoppedDown = true; } });
  first.tree.props.onKeyUp({ stopPropagation() { stoppedUp = true; } });
  assert.equal(stoppedDown, true);
  assert.equal(stoppedUp, true);

  // Master password security attributes
  assert.equal(first.passInput.props.type, 'password');
  assert.equal(first.passInput.props.autoComplete, 'new-password');
  assert.equal(first.passInput.props.spellCheck, false);
  assert.equal(first.passInput.props['data-1p-ignore'], 'true');
  assert.equal(first.passInput.props['data-bwignore'], 'true');
  assert.equal(first.passInput.props['data-form-type'], 'other');
  assert.equal(first.cells.length, 6);
  assert.equal(first.cells[0].props.autoComplete, 'one-time-code');
  assert.equal(first.cells[1].props.autoComplete, 'off');

  // Pressing Enter in masterPassword when OTP is empty triggers send() rather than premature form submit
  passwordBox.value = 'wrong-password';
  let enterDefaultPrevented = false;
  first.passInput.props.onKeyDown({
    key: 'Enter',
    preventDefault() { enterDefaultPrevented = true; },
  });
  assert.equal(enterDefaultPrevented, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1).action, 'send');
  assert.equal(passwordBox.value, '');

  // Successful send preserves master password for step 2 and resets OTP cells
  const sendBtn = findAll(first.tree, n => n.type === 'button' && n.props.className === 'dsh-lock-pass-send')[0];
  passwordBox.value = 'correct-master-password';
  await sendBtn.props.onClick();
  assert.equal(passwordBox.value, 'correct-master-password');

  // Partial OTP submit focuses the first empty slot without firing network request
  const partialMount = mount(false);
  partialMount.cells[0].props.onPaste({
    preventDefault() {},
    clipboardData: { getData: () => '482' },
  });
  const afterPartial = mount(false);
  otpBoxes.forEach(box => { box.focused = false; });
  const partialForm = findAll(afterPartial.tree, n => n.type === 'form')[0];
  assert.equal(partialForm.props.noValidate, true);
  await partialForm.props.onSubmit({ preventDefault() {} });
  assert.equal(otpBoxes[3].focused, true);
  assert.equal(calls.length, 2);

  // Paste 6-digit OTP and check Enter in masterPassword now allows form submission
  afterPartial.cells[0].props.onPaste({
    preventDefault() {},
    clipboardData: { getData: () => '482916' },
  });
  const third = mount(false);
  assert.deepEqual(third.cells.map(c => c.props.value), ['4', '8', '2', '9', '1', '6']);
  let fullEnterPrevented = false;
  third.passInput.props.onKeyDown({
    key: 'Enter',
    preventDefault() { fullEnterPrevented = true; },
  });
  assert.equal(fullEnterPrevented, false);

  const form = findAll(third.tree, n => n.type === 'form')[0];
  const unlockPromise = form.props.onSubmit({ preventDefault() {} });
  // Secrets cleared synchronously before unlock resolves!
  assert.equal(passwordBox.value, '');
  const duringUnlock = mount(false);
  assert.deepEqual(duringUnlock.cells.map(c => c.props.value), ['', '', '', '', '', '']);

  resolveUnlock({ ok: true });
  await unlockPromise;
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), {
    action: 'unlock',
    payload: { code: '482916', masterPassword: 'correct-master-password' },
  });

  // Unmount clears both password ref and OTP DOM cell values as defense in depth
  passwordBox.value = 'residual-secret';
  otpBoxes[0].value = '9';
  h.reset();
  assert.equal(passwordBox.value, '');
  assert.equal(otpBoxes[0].value, '');
});

test('CleanupDialog uses opaque Stillpoint chrome, blocks Escape, and disables retry while checking', async () => {
  const h = createHarness();
  const t = bindDict(h.en);
  let resolveRefresh;
  const service = {
    refresh: () => new Promise(resolve => { resolveRefresh = resolve; }),
    async post() { return { ok: false }; },
  };
  const dialogEl = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const retryEl = { focused: false, focus() { this.focused = true; } };

  function mountCleanup(issue = 'cleanup') {
    return h.render(
      h.CleanupDialog,
      { t, service, issue, snapshot: { mode: 'error', issue, status: 'ready' } },
      rendered => {
        rendered.props.ref.current = dialogEl;
        const btn = findAll(rendered, n => n.type === 'button')[0];
        btn.props.ref.current = retryEl;
      },
    );
  }

  const tree = mountCleanup('cleanup');
  assert.equal(dialogEl.open, true);
  assert.equal(retryEl.focused, true);
  assert.equal(tree.props['aria-modal'], true);
  assert.match(tree.props.className, /\bdsh-lock-gate-dialog\b/);
  assert.match(textOf(tree), /ATTENTION/);
  assert.match(textOf(tree), /Managed plugins did not stop cleanly/);

  let canceled = false;
  tree.props.onCancel({ preventDefault() { canceled = true; } });
  assert.equal(canceled, true);

  const retryBtn = findAll(tree, n => n.type === 'button')[0];
  const pendingRefresh = retryBtn.props.onClick();
  const busyTree = mountCleanup('cleanup');
  const busyBtn = findAll(busyTree, n => n.type === 'button')[0];
  assert.equal(busyBtn.props.disabled, true);
  assert.match(textOf(busyTree), /Checking the workspace lock/);

  resolveRefresh();
  await pendingRefresh;
  h.reset();
  assert.equal(dialogEl.open, false);
});
