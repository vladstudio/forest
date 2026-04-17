const vscode = acquireVsCodeApi();
let mode = 'list';
let latestData = null;
let formInit = null;
let formState = null;
let deleteInit = null;
let deleteState = null;
let optimisticCleaningKeys = new Set();
let pendingAction = null; // { cmd: string, key: string|null }
let loadingMessage = null; // string | null

const pendingLabels = {
  pull: 'pulling…', push: 'pushing…', mergeFromMain: 'merging…',
  commit: 'committing…', discard: 'discarding…', ship: 'shipping…', shipMerge: 'shipping…',
  pickBranch: 'loading…', pickIssue: 'loading…', openTicket: 'opening…',
  workingDiff: 'loading…', branchDiff: 'loading…', mainDiff: 'loading…',
};

function defaultFormState(init) {
  return {
    branchMode: 'new',
    branchName: '',
    existingBranch: null,
    branchManuallyEdited: false,
    ticketMode: init.linearEnabled ? 'new' : 'none',
    ticketId: null,
    ticketTitle: null,
    newTicketTitle: '',
    priority: 2,
    team: init.teams && init.teams[0] || '',
    carryChanges: init.uncommittedCount > 0,
    submitting: false,
    error: null,
  };
}

function defaultDeleteState(init) {
  return {
    key: init.key,
    branches: init.defaultBranches,
    linear: init.defaultLinearAction,
    pr: init.defaultPrAction,
    submitting: false,
    error: null,
  };
}

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'update':
      latestData = msg.data;
      if (mode === 'list') renderCurrentMode();
      break;
    case 'pendingDone':
      pendingAction = null;
      renderCurrentMode();
      break;
    case 'showCreateForm':
      mode = 'create';
      loadingMessage = null;
      formInit = msg.init;
      formState = defaultFormState(msg.init);
      renderCurrentMode();
      break;
    case 'showDeleteForm':
      mode = 'delete';
      loadingMessage = null;
      deleteInit = msg.init;
      deleteState = defaultDeleteState(msg.init);
      renderCurrentMode();
      break;
    case 'branchPickResult':
      if (formState && msg.branch) {
        formState.branchMode = 'existing';
        formState.existingBranch = msg.branch;
      }
      renderCurrentMode();
      break;
    case 'issuePickResult':
      if (formState && msg.issue) {
        formState.ticketMode = 'existing';
        formState.ticketId = msg.issue.ticketId;
        formState.ticketTitle = msg.issue.title;
        autoFillBranch();
      }
      renderCurrentMode();
      break;
    case 'createResult':
      if (formState) {
        formState.submitting = false;
        if (msg.success) {
          mode = 'list';
        } else {
          formState.error = msg.error;
        }
        renderCurrentMode();
      }
      break;
    case 'deleteResult':
      if (msg.key) optimisticCleaningKeys.delete(msg.key);
      if (deleteState) {
        deleteState.submitting = false;
        if (!msg.success) {
          deleteState.error = msg.error;
        }
      }
      mode = 'list';
      renderCurrentMode();
      break;
  }
});

document.getElementById('root').addEventListener('click', e => {
  const formBtn = e.target.closest('[data-form]');
  if (formBtn) {
    if (formBtn.disabled) return;
    handleFormAction(formBtn.dataset.form);
    return;
  }
  const btn = e.target.closest('[data-cmd]');
  if (!btn) return;
  if (btn.disabled) return;
  if (btn.dataset.cmd === 'createForm:submit' && formState) {
    formState.submitting = true;
    formState.error = null;
    renderCreateForm();
    const sanitized = sanitizeBranch(formState.branchName);
    vscode.postMessage({
      command: 'createForm:submit',
      branchMode: formState.branchMode,
      branchName: sanitized,
      existingBranch: formState.existingBranch,
      ticketMode: formState.ticketMode,
      ticketId: formState.ticketId,
      ticketTitle: formState.ticketTitle,
      newTicketTitle: formState.newTicketTitle,
      priority: formState.priority,
      team: formState.team,
      carryChanges: formState.carryChanges,
      branchManuallyEdited: formState.branchManuallyEdited,
    });
    return;
  }
  if (btn.dataset.cmd === 'deleteForm:submit' && deleteState) {
    optimisticCleaningKeys.add(deleteState.key);
    deleteState.submitting = true;
    deleteState.error = null;
    mode = 'list';
    renderCurrentMode();
    vscode.postMessage({
      command: 'deleteForm:submit',
      key: deleteState.key,
      branches: deleteState.branches,
      linear: deleteState.linear,
      pr: deleteState.pr,
    });
    return;
  }
  if (btn.dataset.cmd === 'cancelPending') {
    vscode.postMessage({ command: 'cancelPending' });
    return;
  }
  const msg = { command: btn.dataset.cmd, key: btn.closest('[data-key]')?.dataset.key };
  if (btn.dataset.done !== undefined) msg.isDoneOrClosed = btn.dataset.done === '1';
  if (btn.dataset.cmd === 'delete') {
    loadingMessage = 'Loading…';
    renderCurrentMode();
  }
  if (pendingLabels[btn.dataset.cmd] && !pendingAction) {
    pendingAction = { cmd: btn.dataset.cmd, key: msg.key || null };
    renderCurrentMode();
  }
  vscode.postMessage(msg);
});

const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dis = v => v ? ' disabled' : '';

function sanitizeBranch(v) {
  return v.replace(/[<>:"|?*\x00-\x1f\s~^\\]+/g, '-').replace(/\.{2,}/g, '-').replace(/\/\//g, '/').replace(/-+/g, '-').replace(/^[-./]+|[-./]+$/g, '');
}

function slugifyStr(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'untitled';
}

function autoFillBranch() {
  if (formState.branchMode !== 'new' || formState.branchManuallyEdited) return;
  if (formState.ticketMode === 'existing' && formState.ticketId) {
    var name = formInit.branchFormat;
    name = name.replace('${ticketId}', formState.ticketId).replace('${slug}', slugifyStr(formState.ticketTitle || ''));
    formState.branchName = sanitizeBranch(name);
  } else if (formState.ticketMode === 'new' && formState.newTicketTitle) {
    formState.branchName = slugifyStr(formState.newTicketTitle);
  } else {
    formState.branchName = '';
  }
}

const icons = {
  house: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M219.31,108.68l-80-80a16,16,0,0,0-22.62,0l-80,80A15.87,15.87,0,0,0,32,120v96a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V160h32v56a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V120A15.87,15.87,0,0,0,219.31,108.68ZM208,208H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48V120l80-80,80,80Z"/></svg>',
  folderOpen: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M245,110.64A16,16,0,0,0,232,104H216V88a16,16,0,0,0-16-16H130.67L102.94,51.2a16.14,16.14,0,0,0-9.6-3.2H40A16,16,0,0,0,24,64V208h0a8,8,0,0,0,8,8H211.1a8,8,0,0,0,7.59-5.47l28.49-85.47A16.05,16.05,0,0,0,245,110.64ZM93.34,64,123.2,86.4A8,8,0,0,0,128,88h72v16H69.77a16,16,0,0,0-15.18,10.94L40,158.7V64Zm112,136H43.1l26.67-80H232Z"/></svg>',
  diff: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="none"/><path d="M200,168V110.63a16,16,0,0,0-4.69-11.32L144,48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><polyline points="144 96 144 48 192 48" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><path d="M56,88v57.37a16,16,0,0,0,4.69,11.32L112,208" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><polyline points="112 160 112 208 64 208" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><circle cx="56" cy="64" r="24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><circle cx="200" cy="192" r="24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>',
  x: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="none"/><line x1="200" y1="56" x2="56" y2="200" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><line x1="200" y1="200" x2="56" y2="56" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>',
  copy: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>',
  arrowDown: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M205.66,149.66l-72,72a8,8,0,0,1-11.32,0l-72-72a8,8,0,0,1,11.32-11.32L120,196.69V40a8,8,0,0,1,16,0V196.69l58.34-58.35a8,8,0,0,1,11.32,11.32Z"/></svg>',
  arrowUp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M205.66,117.66a8,8,0,0,1-11.32,0L136,59.31V216a8,8,0,0,1-16,0V59.31L61.66,117.66a8,8,0,0,1-11.32-11.32l72-72a8,8,0,0,1,11.32,0l72,72A8,8,0,0,1,205.66,117.66Z"/></svg>',
  trash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>',
  link: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M240,88.23a54.43,54.43,0,0,1-16,37L189.25,160a54.27,54.27,0,0,1-38.63,16h-.05A54.63,54.63,0,0,1,96,119.84a8,8,0,0,1,16,.45A38.62,38.62,0,0,0,150.58,160h0a38.39,38.39,0,0,0,27.31-11.31l34.75-34.75a38.63,38.63,0,0,0-54.63-54.63l-11,11A8,8,0,0,1,135.7,59l11-11A54.65,54.65,0,0,1,224,48,54.86,54.86,0,0,1,240,88.23ZM109,185.66l-11,11A38.41,38.41,0,0,1,70.6,208h0a38.63,38.63,0,0,1-27.29-65.94L78,107.31A38.63,38.63,0,0,1,144,135.71a8,8,0,0,0,16,.45A54.86,54.86,0,0,0,144,96a54.65,54.65,0,0,0-77.27,0L32,130.75A54.62,54.62,0,0,0,70.56,224h0a54.28,54.28,0,0,0,38.64-16l11-11A8,8,0,0,0,109,185.66Z"/></svg>',
  gitBranch: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="M232,64a32,32,0,1,0-40,31v17a8,8,0,0,1-8,8H96a23.84,23.84,0,0,0-8,1.38V95a32,32,0,1,0-16,0v66a32,32,0,1,0,16,0V144a8,8,0,0,1,8-8h88a24,24,0,0,0,24-24V95A32.06,32.06,0,0,0,232,64ZM64,64A16,16,0,1,1,80,80,16,16,0,0,1,64,64ZM96,192a16,16,0,1,1-16-16A16,16,0,0,1,96,192ZM200,80a16,16,0,1,1,16-16A16,16,0,0,1,200,80Z"/></svg>',
  linear: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="none"/><polyline points="88 136 112 160 168 104" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><rect x="40" y="40" width="176" height="176" rx="8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>',
  checkbox: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect x="40" y="40" width="176" height="176" rx="8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/><polyline points="88 136 112 160 168 104" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"/></svg>',
};
const ic = name => '<span class="icon">' + icons[name] + '</span>';

function renderLoading(message) {
  document.getElementById('root').innerHTML =
    '<div class="form"><div class="form-section"><div class="form-title"><span class="btn-pending" style="border:none;padding:0">' + h(message) + '</span></div></div>' +
    '<div class="form-actions"><button class="btn-cancel" data-form="cancel">Cancel</button></div></div>';
}

function renderCurrentMode() {
  if (loadingMessage) {
    renderLoading(loadingMessage);
  } else if (mode === 'create' && formState) {
    renderCreateForm();
  } else if (mode === 'delete' && deleteState) {
    renderDeleteForm();
  } else if (latestData) {
    renderList(latestData);
  }
}

function radioOption(name, value, currentValue, title, disabled, subtitle) {
  return '<label class="radio-option' + (disabled ? ' disabled' : '') + '">' +
    '<input type="radio" name="' + h(name) + '" value="' + h(value) + '"' +
    (currentValue === value ? ' checked' : '') +
    (disabled ? ' disabled' : '') +
    '>' +
    '<span class="radio-body"><div class="radio-title">' + h(title) + '</div>' +
    (subtitle ? '<div class="form-copy" style="opacity:0.7">' + h(subtitle) + '</div>' : '') +
    '</span>' +
  '</label>';
}

function renderList(d) {
  const data = withOptimisticCleaning(d);
  const parts = [mainCard(data)];
  if (!data.groups.length) parts.push('<p class="empty">No trees yet. Click + to create one.</p>');
  for (const g of data.groups) {
    parts.push('<div class="group">' + h(g.label) + ' <span>' + g.trees.length + '</span></div>');
    for (const t of g.trees) parts.push(treeCard(t, data));
  }
  document.getElementById('root').innerHTML = parts.join('');
}

function withOptimisticCleaning(data) {
  if (!data || !optimisticCleaningKeys.size) return data;

  var moved = [];
  var groups = [];
  for (var i = 0; i < data.groups.length; i++) {
    var group = data.groups[i];
    var trees = [];
    for (var j = 0; j < group.trees.length; j++) {
      var tree = group.trees[j];
      if (!tree.cleaning && optimisticCleaningKeys.has(tree.key)) {
        moved.push({ ...tree, cleaning: true });
      } else {
        trees.push(tree);
      }
    }
    if (trees.length) groups.push({ label: group.label, trees: trees });
  }

  if (!moved.length) return data;

  var cleaningIdx = groups.findIndex(function(group) { return group.label === 'Cleaning up'; });
  if (cleaningIdx >= 0) {
    groups[cleaningIdx] = {
      label: groups[cleaningIdx].label,
      trees: moved.concat(groups[cleaningIdx].trees),
    };
  } else {
    groups.unshift({ label: 'Cleaning up', trees: moved });
  }

  return { ...data, groups: groups };
}

function mainCard(d) {
  const cls = 'card card-main' + (d.mainIsCurrent ? ' current' : '');
  const label = h(d.baseBranch) + ' · ' + h(d.repoName);
  if (d.mainIsCurrent) {
    var isPending = pendingAction && pendingAction.key === '__main__';
    var pCmd = isPending ? pendingAction.cmd : null;
    var allDis = isPending;
    var pullLabel = d.mainBehind > 0 ? ic('arrowDown') + d.mainBehind : ic('arrowDown');
    return '<div class="' + cls + '" data-key="__main__"><span class="card-label">' + label + '</span>' +
      '<div class="row">' +
        '<button class="btn" data-cmd="revealInFinder" title="Reveal in Finder"' + dis(allDis) + '>' + ic('folderOpen') + '</button>' +
        btn('pull', pullLabel, allDis, pCmd, { attrs: 'title="Pull"' }) +
      '</div></div>';
  }
  return '<div class="' + cls + '" data-key="__main__"><a class="card-label" data-cmd="switchToMain">' + label + '</a></div>';
}

function pendingBtn(label) {
  return '<button class="btn btn-pending" disabled>' + label + '</button><button class="btn" data-cmd="cancelPending" title="Cancel">' + ic('x') + '</button>';
}

function btn(cmd, label, allDisabled, pendingCmd, opts) {
  if (pendingCmd === cmd) return pendingBtn(pendingLabels[cmd] || 'loading…');
  var cls = 'btn' + (opts && opts.cls ? ' ' + opts.cls : '');
  var extra = opts && opts.attrs ? ' ' + opts.attrs : '';
  return '<button class="' + cls + '" data-cmd="' + h(cmd) + '"' + extra + dis(allDisabled) + '>' + label + '</button>';
}

function treeCard(t, d) {
  const branchLabel = h(t.branch);
  if (t.cleaning) return '<div class="card" data-key="' + h(t.key) + '"><div class="row"><span class="branch">' + branchLabel + '</span><span class="dim">cleaning up…</span></div></div>';
  if (!t.isCurrent) {
    const isDoneOrClosed = t.prState === 'MERGED' || t.prState === 'CLOSED';
    const deleteBtn = isDoneOrClosed ? '<button class="btn danger" data-cmd="delete" data-done="1" title="Delete tree">' + ic('trash') + '</button>' : '';
    return '<div class="card" data-key="' + h(t.key) + '"><div class="row"><a class="branch" data-cmd="switch" title="' + h(t.branch) + '">' + branchLabel + '</a>' + deleteBtn + '</div></div>';
  }
  const isPending = pendingAction && pendingAction.key === t.key;
  const pendingCmd = isPending ? pendingAction.cmd : null;
  const allDisabled = !!t.busyOperation || isPending;
  const busy = !isPending && t.busyOperation ? '<span class="dim">' + h(t.busyOperation) + '…</span>' : '';
  const behind = t.behind > 0 ? btn('mergeFromMain', 'main ↓' + t.behind, allDisabled, pendingCmd, { attrs: 'title="Merge ' + t.behind + ' commits from main"' }) : '';
  const pushLabel = t.ahead > 0 ? ic('arrowUp') + t.ahead : ic('arrowUp');
  let ticket = '';
  if (d.linearEnabled) {
    if (t.ticketId) {
      const lbl = t.ticketId + (t.ticketTitle ? ': ' + t.ticketTitle : '');
      const ticketLink = pendingCmd === 'openTicket'
        ? '<span class="ticket dim">' + (pendingLabels.openTicket || 'loading…') + '</span>'
        : '<a class="ticket" data-cmd="openTicket" title="' + h(lbl) + '"' + (allDisabled ? ' style="pointer-events:none;opacity:0.5"' : '') + '>' + h(lbl) + '</a>';
      ticket = '<div class="row">' + ticketLink + (pendingCmd === 'openTicket' ? '<button class="btn" data-cmd="cancelPending" title="Cancel">' + ic('x') + '</button>' : '<button class="btn" data-cmd="detachTicket"' + dis(allDisabled) + '>detach</button>') + '</div>';
    } else {
      ticket = '<div class="row"><button class="btn faint" data-cmd="linkTicket" style="flex:1"' + dis(allDisabled) + '>No ticket</button></div>';
    }
  }
  let changes = '';
  if (t.localChanges) {
    const lc = t.localChanges;
    const stats = [lc.added ? '<span class="add">+' + lc.added + '</span>' : '', lc.removed ? '<span class="del">-' + lc.removed + '</span>' : '', lc.modified ? '<span class="mod">~' + lc.modified + '</span>' : ''].filter(Boolean).join(' ');
    changes = '<div class="row"><span class="stats">' + stats + '</span>' +
      btn('workingDiff', ic('diff'), allDisabled, pendingCmd, { attrs: 'title="Diff working changes"' }) +
      btn('branchDiff', 'Diff branch', allDisabled, pendingCmd, { attrs: 'title="Diff branch changes"' }) +
      (d.hasAI ? btn('commit', 'commit', allDisabled, pendingCmd) : '') +
      btn('discard', ic('x'), allDisabled, pendingCmd, { cls: 'danger', attrs: 'title="Discard changes"' }) + '</div>';
  }
  const isDone = t.prState === 'MERGED' || t.prState === 'CLOSED';
  const doneFlag = isDone ? '1' : '0';
  const lastRow = (isDone || t.prNumber)
    ? '<button class="btn fill" data-cmd="openPR"' + dis(allDisabled) + '>PR#' + (t.prNumber || '?') + '</button>' + btn('delete', ic('trash'), allDisabled, null, { cls: 'danger', attrs: 'data-done="' + doneFlag + '" title="Delete tree"' })
    : (d.hasAutomerge
        ? btn('ship', 'Ship', allDisabled, pendingCmd, { cls: 'fill', attrs: 'title="Push and create PR"' })
          + btn('shipMerge', 'Ship + Automerge', allDisabled, pendingCmd, { cls: 'fill', attrs: 'title="Push, create PR, enable auto-merge"' })
        : btn('ship', 'Ship - Push and Create PR', allDisabled, pendingCmd, { cls: 'fill' }))
      + btn('delete', ic('trash'), allDisabled, null, { cls: 'danger', attrs: 'data-done="0" title="Delete tree"' });
  return '<div class="card current" data-key="' + h(t.key) + '">' +
    ticket +
    '<div class="row"><span class="branch" title="' + h(t.branch) + '">' + branchLabel + '</span>' + busy + '</div>' +
    '<div class="row">' +
      '<button class="btn" data-cmd="revealInFinder" title="Reveal in Finder"' + dis(allDisabled) + '>' + ic('folderOpen') + '</button>' +
      '<button class="btn" data-cmd="copyBranch" title="Copy branch name"' + dis(allDisabled) + '>' + ic('copy') + '</button>' +
      btn('pull', t.remoteBehind > 0 ? ic('arrowDown') + t.remoteBehind : ic('arrowDown'), allDisabled, pendingCmd, { attrs: 'title="Pull from remote"' }) +
      behind +
      btn('push', pushLabel, allDisabled, pendingCmd, { attrs: 'title="Push to remote"' }) +
      btn('mainDiff', 'Diff main', allDisabled, pendingCmd, { attrs: 'title="Diff main against branch"' }) +
    '</div>' +
    changes +
    '<div class="row">' + lastRow + '</div>' +
  '</div>';
}

function renderDeleteForm() {
  const ds = deleteState;
  const init = deleteInit;
  const dis = ds.submitting;
  let out = '<div class="form">';

  if (ds.error) {
    out += '<div class="form-error">' + h(ds.error) + '</div>';
  }

  out += '<div class="form-section">';
  out += '<div class="form-title">Delete ' + h(init.name) + '</div>';
  out += '</div>';

  out += '<div class="form-section">';
  out += '<div class="form-title">Branches</div>';
  out += '<div class="radio-group">';
  if (init.remoteDeleted) {
    out += radioOption('delete-branches', 'all', ds.branches, 'Delete local + remote', true, 'Remote branch is already deleted.');
  } else {
    out += radioOption('delete-branches', 'all', ds.branches, 'Delete local + remote', dis);
  }
  out += radioOption('delete-branches', 'local', ds.branches, 'Delete local only', dis);
  out += radioOption('delete-branches', 'keep', ds.branches, 'Keep branches', dis);
  out += '</div></div>';

  if (init.linearEnabled) {
    out += '<div class="form-section">';
    out += '<div class="form-title">Linear</div>';
    out += '<div class="radio-group">';
    out += radioOption('delete-linear', 'cancel', ds.linear, 'Move to canceled', dis);
    out += radioOption('delete-linear', 'cleanup', ds.linear, 'Move to done', dis);
    out += radioOption('delete-linear', 'none', ds.linear, 'Do nothing', dis);
    out += '</div></div>';
  }

  if (init.prState === 'OPEN') {
    out += '<div class="form-section">';
    out += '<div class="form-title">Pull Request</div>';
    out += '<div class="radio-group">';
    out += radioOption('delete-pr', 'close', ds.pr, 'Close PR', dis);
    out += radioOption('delete-pr', 'none', ds.pr, 'Do nothing', dis);
    out += '</div></div>';
  } else if (init.prState === 'MERGED' || init.prState === 'CLOSED') {
    out += '<div class="form-section">';
    out += '<div class="form-title">Pull Request</div>';
    out += '<div class="form-copy">PR #' + h(init.prNumber || '?') + ' is already ' + h(init.prState.toLowerCase()) + '.</div>';
    out += '</div>';
  }

  out += '<div class="form-actions">';
  out += '<button class="btn-create" id="deleteSubmitBtn" data-cmd="deleteForm:submit"' + (dis ? ' disabled' : '') + '>' + (dis ? 'Deleting…' : 'Delete tree') + '</button>';
  out += '<button class="btn-cancel" data-form="cancel"' + (dis ? ' disabled' : '') + '>Cancel</button>';
  out += '</div>';

  out += '</div>';
  document.getElementById('root').innerHTML = out;
  setupDeleteListeners();
}

function renderCreateForm() {
  const fs = formState;
  const init = formInit;
  const dis = fs.submitting;
  let out = '<div class="form">';

  if (fs.error) {
    out += '<div class="form-error">' + h(fs.error) + '</div>';
  }

  // Linear section
  if (init.linearEnabled) {
    out += '<div class="form-section">';
    out += '<div class="form-row">';
    if (fs.ticketMode === 'existing' && fs.ticketId) {
      out += '<span class="form-value">' + h(fs.ticketId + (fs.ticketTitle ? ': ' + fs.ticketTitle : '')) + '</span>';
    } else if (fs.ticketMode === 'new') {
      out += '<span class="form-value dim">New Linear ticket</span>';
    } else {
      out += '<span class="form-value dim">No Linear ticket</span>';
    }
    out += '</div>';
    out += '<div class="form-row">';
    if (pendingAction && pendingAction.cmd === 'pickIssue') {
      out += '<button class="btn btn-pending" disabled>loading…</button><button class="btn" data-cmd="cancelPending" title="Cancel">' + ic('x') + '</button>';
    } else {
      out += '<button class="btn" data-cmd="pickIssue"' + (dis || pendingAction ? ' disabled' : '') + '>Select ticket</button>';
    }
    out += '<button class="btn' + (fs.ticketMode === 'new' ? ' btn-toggle active' : '') + '" data-form="ticketNew"' + (dis || pendingAction ? ' disabled' : '') + '>Create new</button>';
    out += '<button class="btn' + (fs.ticketMode === 'none' ? ' btn-toggle active' : '') + '" data-form="ticketNone"' + (dis || pendingAction ? ' disabled' : '') + '>No ticket</button>';
    out += '</div>';

    if (fs.ticketMode === 'new') {
      out += '<input class="form-input" id="ticketTitleInput" placeholder="Issue title" value="' + h(fs.newTicketTitle) + '"' + (dis ? ' disabled' : '') + '>';
      out += '<div class="form-row" style="margin-top:6px">';
      out += '<select class="form-select" id="prioritySelect"' + (dis ? ' disabled' : '') + '>';
      out += '<option value="0"' + (fs.priority === 0 ? ' selected' : '') + '>No priority</option>';
      out += '<option value="1"' + (fs.priority === 1 ? ' selected' : '') + '>Urgent</option>';
      out += '<option value="2"' + (fs.priority === 2 ? ' selected' : '') + '>High</option>';
      out += '<option value="3"' + (fs.priority === 3 ? ' selected' : '') + '>Normal</option>';
      out += '<option value="4"' + (fs.priority === 4 ? ' selected' : '') + '>Low</option>';
      out += '</select>';
      if (init.teams.length > 1) {
        out += '<select class="form-select" id="teamSelect"' + (dis ? ' disabled' : '') + '>';
        for (var i = 0; i < init.teams.length; i++) {
          out += '<option value="' + h(init.teams[i]) + '"' + (fs.team === init.teams[i] ? ' selected' : '') + '>' + h(init.teams[i]) + '</option>';
        }
        out += '</select>';
      }
      out += '</div>';
    }
    out += '</div>';
  }

  // Branch section
  out += '<div class="form-section">';
  out += '<div class="form-row">';
  if (fs.branchMode === 'existing' && fs.existingBranch) {
    out += '<span class="form-value">' + h(fs.existingBranch) + '</span>';
  } else {
    out += '<span class="form-value dim">New branch</span>';
  }
  out += '</div>';
  out += '<div class="form-row">';
  if (pendingAction && pendingAction.cmd === 'pickBranch') {
    out += '<button class="btn btn-pending" disabled>loading…</button><button class="btn" data-cmd="cancelPending" title="Cancel">' + ic('x') + '</button>';
  } else {
    out += '<button class="btn" data-cmd="pickBranch"' + (dis || pendingAction ? ' disabled' : '') + '>Select branch</button>';
  }
  if (fs.branchMode === 'existing') {
    out += '<button class="btn" data-form="branchNew"' + (dis ? ' disabled' : '') + '>Create new</button>';
  }
  out += '</div>';
  if (fs.branchMode === 'new') {
    out += '<input class="form-input" id="branchNameInput" placeholder="my-feature-branch" value="' + h(fs.branchName) + '"' + (dis ? ' disabled' : '') + '>';
    out += '<div class="form-hint" id="branchHint" style="display:none"></div>';
    if (fs.ticketMode === 'new' && fs.newTicketTitle && !fs.branchManuallyEdited) {
      out += '<div class="form-hint">Ticket ID will be prepended after creation</div>';
    }
  }
  out += '</div>';

  // Uncommitted changes
  if (init.uncommittedCount > 0) {
    out += '<div class="form-section">';
    out += '<div class="form-row">';
    out += '<span class="form-value dim">' + init.uncommittedCount + ' uncommitted file' + (init.uncommittedCount !== 1 ? 's' : '') + '</span>';
    out += '<button class="btn btn-toggle' + (fs.carryChanges ? ' active' : '') + '" data-form="carryYes"' + (dis ? ' disabled' : '') + '>Carry</button>';
    out += '<button class="btn btn-toggle' + (!fs.carryChanges ? ' active' : '') + '" data-form="carryNo"' + (dis ? ' disabled' : '') + '>Ignore</button>';
    out += '</div>';
    out += '</div>';
  }

  // Action buttons
  var canSubmit = !dis && (
    (fs.branchMode === 'new' ? !!sanitizeBranch(fs.branchName) : !!fs.existingBranch) &&
    (fs.ticketMode !== 'new' || !!fs.newTicketTitle.trim())
  );
  out += '<div class="form-actions">';
  out += '<button class="btn-create" id="submitBtn" data-cmd="createForm:submit"' + (canSubmit ? '' : ' disabled') + '>' + (dis ? 'Creating…' : 'Create tree') + '</button>';
  out += '<button class="btn-cancel" data-form="cancel"' + (dis ? ' disabled' : '') + '>Cancel</button>';
  out += '</div>';

  out += '</div>';
  document.getElementById('root').innerHTML = out;
  setupFormListeners();
}

function setupDeleteListeners() {
  var branchRadios = document.querySelectorAll('input[name="delete-branches"]');
  branchRadios.forEach(function(input) {
    input.addEventListener('change', function(e) {
      deleteState.branches = e.target.value;
    });
  });
  var linearRadios = document.querySelectorAll('input[name="delete-linear"]');
  linearRadios.forEach(function(input) {
    input.addEventListener('change', function(e) {
      deleteState.linear = e.target.value;
    });
  });
  var prRadios = document.querySelectorAll('input[name="delete-pr"]');
  prRadios.forEach(function(input) {
    input.addEventListener('change', function(e) {
      deleteState.pr = e.target.value;
    });
  });
}

function setupFormListeners() {
  var branchInput = document.getElementById('branchNameInput');
  if (branchInput) {
    branchInput.addEventListener('input', function(e) {
      formState.branchName = e.target.value;
      formState.branchManuallyEdited = e.target.value.length > 0;
      updateFormHints();
    });
    if (formState.ticketMode !== 'new' || formState.newTicketTitle) branchInput.focus();
  }
  var ticketInput = document.getElementById('ticketTitleInput');
  if (ticketInput) {
    ticketInput.addEventListener('input', function(e) {
      formState.newTicketTitle = e.target.value;
      autoFillBranch();
      var bi = document.getElementById('branchNameInput');
      if (bi) bi.value = formState.branchName;
      updateFormHints();
    });
    if (!formState.newTicketTitle) ticketInput.focus();
  }
  var prioritySelect = document.getElementById('prioritySelect');
  if (prioritySelect) {
    prioritySelect.addEventListener('change', function(e) {
      formState.priority = parseInt(e.target.value, 10);
    });
  }
  var teamSelect = document.getElementById('teamSelect');
  if (teamSelect) {
    teamSelect.addEventListener('change', function(e) {
      formState.team = e.target.value;
    });
  }
  updateFormHints();
}

function updateFormHints() {
  var hint = document.getElementById('branchHint');
  if (hint) {
    var sanitized = sanitizeBranch(formState.branchName);
    if (sanitized && sanitized !== formState.branchName) {
      hint.textContent = 'Branch: ' + sanitized;
      hint.style.display = '';
    } else {
      hint.style.display = 'none';
    }
  }
  var submitBtn = document.getElementById('submitBtn');
  if (submitBtn) {
    var canSubmit = !formState.submitting && (
      (formState.branchMode === 'new' ? !!sanitizeBranch(formState.branchName) : !!formState.existingBranch) &&
      (formState.ticketMode !== 'new' || !!formState.newTicketTitle.trim())
    );
    submitBtn.disabled = !canSubmit;
  }
}

function handleFormAction(action) {
  switch (action) {
    case 'branchNew':
      formState.branchMode = 'new';
      formState.existingBranch = null;
      formState.branchManuallyEdited = false;
      autoFillBranch();
      break;
    case 'ticketNew':
      formState.ticketMode = 'new';
      formState.ticketId = null;
      formState.ticketTitle = null;
      autoFillBranch();
      break;
    case 'ticketNone':
      formState.ticketMode = 'none';
      formState.ticketId = null;
      formState.ticketTitle = null;
      autoFillBranch();
      break;
    case 'carryYes':
      formState.carryChanges = true;
      break;
    case 'carryNo':
      formState.carryChanges = false;
      break;
    case 'cancel':
      mode = 'list';
      loadingMessage = null;
      break;
  }
  renderCurrentMode();
}
