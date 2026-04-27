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
  pickBranch: 'loading…', pickIssue: 'loading…', openTicket: 'opening…', copyTicketDescription: 'copying…',
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
    useDevcontainer: false,
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
      useDevcontainer: formState.useDevcontainer,
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

const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

const ic = name => '<span class="icon">' + icons[name] + '</span>';

function renderLoading(message) {
  document.getElementById('root').innerHTML =
    '<div class="form"><div class="form-section"><div class="form-title"><span class="dim">' + h(message) + '</span></div></div>' +
    '<div class="form-actions"><button class="btn secondary" data-form="cancel">Cancel</button></div></div>';
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

  var cleaningIdx = groups.findIndex(function (group) { return group.label === 'Deleting'; });
  if (cleaningIdx >= 0) {
    groups[cleaningIdx] = {
      label: groups[cleaningIdx].label,
      trees: moved.concat(groups[cleaningIdx].trees),
    };
  } else {
    groups.push({ label: 'Deleting', trees: moved });
  }

  return { ...data, groups: groups };
}

function mainCard(d) {
  const cls = 'card card-main' + (d.mainIsCurrent ? ' current' : '');
  const label = h(d.baseBranch) + ' · ' + h(d.repoName);
  if (d.mainIsCurrent) {
    const isPending = pendingAction && pendingAction.key === '__main__';
    const allDis = isPending;
    const statusBar = isPending ? '<div class="row status-bar"><span class="spinner"></span><span class="dim">' + h(pendingLabels[pendingAction.cmd] || 'loading…') + '</span>' + btn('cancelPending', ic('x'), false, { attrs: 'title="Cancel"' }) + '</div>' : '';
    return '<div class="' + cls + '" data-key="__main__"><div class="row"><span class="card-label">' + label + '</span>' +
      '<button class="btn" data-cmd="revealInFinder" title="Reveal in Finder"' + dis(allDis) + '>' + ic('folderOpen') + '</button>' +
      btn('pull', ic('arrowDown') + (d.mainBehind > 0 ? d.mainBehind : ''), allDis, { attrs: 'title="Pull"' }) +
      '</div>' + statusBar + '</div>';
  }
  return '<div class="' + cls + '" data-key="__main__" data-cmd="switchToMain"><span class="card-label">' + label + '</span></div>';
}

function btn(cmd, label, allDisabled, opts) {
  var cls = 'btn' + (opts && opts.cls ? ' ' + opts.cls : '');
  var extra = opts && opts.attrs ? ' ' + opts.attrs : '';
  return '<button class="' + cls + '" data-cmd="' + h(cmd) + '"' + extra + dis(allDisabled) + '>' + label + '</button>';
}

function treeCard(t, d) {
  const bl = h(t.branch);
  if (t.cleaning) return '<div class="card" data-key="' + h(t.key) + '"><div class="row"><span class="branch">' + bl + '</span><span class="dim">cleaning up…</span></div></div>';
  if (!t.isCurrent) {
    const done = t.prState === 'MERGED' || t.prState === 'CLOSED';
    return '<div class="card" data-key="' + h(t.key) + '" data-cmd="switch"><div class="row"><span class="branch">' + bl + '</span>' + (done ? '<button class="btn danger" data-cmd="delete" data-done="1" title="Delete tree">' + ic('trash') + '</button>' : '') + '</div></div>';
  }
  const isPending = pendingAction && pendingAction.key === t.key;
  const allDis = !!t.busyOperation || isPending;
  const lc = t.localChanges;
  const stats = lc ? [lc.added && '<span class="add">+' + lc.added + '</span>', lc.removed && '<span class="del">-' + lc.removed + '</span>', lc.modified && '<span class="mod">~' + lc.modified + '</span>'].filter(Boolean).join(' ') : '';
  const isDone = t.prState === 'MERGED' || t.prState === 'CLOSED';
  let ticket = '';
  if (d.linearEnabled) {
    const lbl = t.ticketId ? h(t.ticketId + (t.ticketTitle ? ': ' + t.ticketTitle : '')) : '';
    ticket = t.ticketId
      ? '<div class="field-label">Linear</div><div class="row"><a class="ticket" data-cmd="openTicket" title="' + lbl + '"' + (allDis ? ' style="pointer-events:none;opacity:0.5"' : '') + '>' + lbl + '</a>' + btn('copyTicketDescription', ic('copy'), allDis, { attrs: 'title="Copy description"' }) + btn('detachTicket', 'Detach', allDis) + '</div>'
      : '<div class="field-label">Linear</div><div class="row equal-fill">' + btn('linkTicket', 'Link Issue', allDis) + btn('newTicket', 'New Issue', allDis) + '</div>';
  }
  const lastRow = (isDone || t.prNumber)
    ? '<button class="btn fill" data-cmd="openPR"' + dis(allDis) + '>PR#' + (t.prNumber || '?') + '</button>' + btn('delete', ic('trash'), allDis, { cls: 'danger', attrs: 'data-done="' + (isDone ? '1' : '0') + '" title="Delete tree"' })
    : (d.hasAutomerge
      ? btn('ship', 'Push + PR', allDis, { cls: 'fill primary', attrs: 'title="Push and create PR"' }) + btn('shipMerge', '+ Automerge', allDis, { cls: 'fill primary', attrs: 'title="Push, create PR, enable auto-merge"' })
      : btn('ship', 'Ship - Push and Create PR', allDis, { cls: 'fill primary' }))
    + btn('delete', ic('trash'), allDis, { cls: 'danger', attrs: 'data-done="0" title="Delete tree"' });
  const busyLabel = isPending ? (pendingLabels[pendingAction.cmd] || 'loading…') : (t.busyOperation ? t.busyOperation + '…' : '');
  const statusBar = busyLabel ? '<div class="row status-bar"><span class="spinner"></span><span class="dim">' + h(busyLabel) + '</span>' + (isPending ? btn('cancelPending', ic('x'), false, { attrs: 'title="Cancel"' }) : '') + '</div>' : '';
  return '<div class="card current" data-key="' + h(t.key) + '">' +
    ticket +
    '<div class="field-label">Branch</div><div class="row"><span class="branch" data-cmd="revealInFinder" title="Reveal in Finder: ' + h(t.branch) + '">' + bl + '</span>' + btn('copyBranch', ic('copy'), allDis, { attrs: 'title="Copy branch name"' }) + '</div>' +
    '<div class="row equal-fill">' +
    btn('pull', ic('arrowDown') + '<span class="label">Pull</span>' + (t.remoteBehind > 0 ? ' ' + t.remoteBehind : ''), allDis, { attrs: 'title="Pull from remote"' }) +
    btn('mergeFromMain', ic('gitMerge') + '<span class="label">Main</span>' + (t.behind > 0 ? ' ' + t.behind : ''), allDis || !t.behind, { attrs: 'title="Merge from main"' }) +
    (d.hasAI ? btn('commit', ic('gitCommit') + '<span class="label">Commit</span>', allDis) : '') +
    btn('push', ic('arrowUp') + '<span class="label">Push</span>' + (t.ahead > 0 ? ' ' + t.ahead : ''), allDis, { attrs: 'title="Push to remote"' }) +
    '</div>' +
    '<div class="row equal-fill">' +
    btn('workingDiff', (stats ? '<span class="stats">' + stats + '</span>' : '') + ic('diff'), allDis || !lc, { attrs: 'title="Diff working changes"' }) +
    btn('branchDiff', ic('diff') + '<span class="label">Branch</span>', allDis, { attrs: 'title="Diff branch changes"' }) +
    btn('mainDiff', ic('diff') + '<span class="label">Main</span>', allDis, { attrs: 'title="Diff main against branch"' }) +
    btn('discard', ic('x'), allDis || !lc, { cls: 'danger', attrs: 'title="Discard changes"' }) +
    '</div>' +
    '<div class="field-label">Tree</div><div class="row">' + lastRow + '</div>' +
    statusBar +
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

  var canDelete = !dis && !pendingAction;
  out += '<div class="form-actions">';
  out += '<button class="btn primary fill" id="deleteSubmitBtn" data-cmd="deleteForm:submit"' + (canDelete ? '' : ' disabled') + '>' + (dis ? '<span class="spinner"></span> Deleting…' : 'Delete tree') + '</button>';
  out += '<button class="btn secondary" data-form="cancel"' + (canDelete ? '' : ' disabled') + '>Cancel</button>';
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
      out += '<span class="form-value dim">New Linear Ticket</span>';
    } else {
      out += '<span class="form-value dim">No Linear Ticket</span>';
    }
    out += '</div>';
    out += '<div class="form-row">';
    if (pendingAction && pendingAction.cmd === 'pickIssue') {
      out += '<button class="btn btn-pending" disabled>loading…</button><button class="btn" data-cmd="cancelPending" title="Cancel">' + ic('x') + '</button>';
    } else {
      out += '<button class="btn" data-cmd="pickIssue"' + (dis || pendingAction ? ' disabled' : '') + '>Select Ticket</button>';
    }
    out += '<button class="btn' + (fs.ticketMode === 'new' ? ' btn-toggle active' : '') + '" data-form="ticketNew"' + (dis || pendingAction ? ' disabled' : '') + '>Create New</button>';
    out += '<button class="btn' + (fs.ticketMode === 'none' ? ' btn-toggle active' : '') + '" data-form="ticketNone"' + (dis || pendingAction ? ' disabled' : '') + '>No Ticket</button>';
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
    out += '<span class="form-value dim">New Branch</span>';
  }
  out += '</div>';
  out += '<div class="form-row">';
  if (pendingAction && pendingAction.cmd === 'pickBranch') {
    out += '<button class="btn btn-pending" disabled>loading…</button><button class="btn" data-cmd="cancelPending" title="Cancel">' + ic('x') + '</button>';
  } else {
    out += '<button class="btn" data-cmd="pickBranch"' + (dis || pendingAction ? ' disabled' : '') + '>Select Branch</button>';
  }
  if (fs.branchMode === 'existing') {
    out += '<button class="btn" data-form="branchNew"' + (dis ? ' disabled' : '') + '>Create New</button>';
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

  // Dev container toggle
  if (init.hasDevcontainer) {
    out += '<div class="form-section">';
    out += '<div class="form-row">';
    out += '<span class="form-value dim">Dev container</span>';
    out += '<button class="btn btn-toggle' + (fs.useDevcontainer ? ' active' : '') + '" data-form="devcontainerYes"' + (dis ? ' disabled' : '') + '>Sandbox</button>';
    out += '<button class="btn btn-toggle' + (!fs.useDevcontainer ? ' active' : '') + '" data-form="devcontainerNo"' + (dis ? ' disabled' : '') + '>Direct</button>';
    out += '</div>';
    out += '</div>';
  }

  // Action buttons
  var canSubmit = !dis && !pendingAction && (
    (fs.branchMode === 'new' ? !!sanitizeBranch(fs.branchName) : !!fs.existingBranch) &&
    (fs.ticketMode !== 'new' || !!fs.newTicketTitle.trim())
  );
  out += '<div class="form-actions">';
  out += '<button class="btn primary fill" id="submitBtn" data-cmd="createForm:submit"' + (canSubmit ? '' : ' disabled') + '>' + (dis ? '<span class="spinner"></span> Creating…' : 'Create tree') + '</button>';
  out += '<button class="btn secondary" data-form="cancel"' + (dis ? ' disabled' : '') + '>Cancel</button>';
  out += '</div>';

  out += '</div>';
  document.getElementById('root').innerHTML = out;
  setupFormListeners();
}

function setupDeleteListeners() {
  var branchRadios = document.querySelectorAll('input[name="delete-branches"]');
  branchRadios.forEach(function (input) {
    input.addEventListener('change', function (e) {
      deleteState.branches = e.target.value;
    });
  });
  var linearRadios = document.querySelectorAll('input[name="delete-linear"]');
  linearRadios.forEach(function (input) {
    input.addEventListener('change', function (e) {
      deleteState.linear = e.target.value;
    });
  });
  var prRadios = document.querySelectorAll('input[name="delete-pr"]');
  prRadios.forEach(function (input) {
    input.addEventListener('change', function (e) {
      deleteState.pr = e.target.value;
    });
  });
}

function setupFormListeners() {
  var branchInput = document.getElementById('branchNameInput');
  if (branchInput) {
    branchInput.addEventListener('input', function (e) {
      formState.branchName = e.target.value;
      formState.branchManuallyEdited = e.target.value.length > 0;
      updateFormHints();
    });
    if (formState.ticketMode !== 'new' || formState.newTicketTitle) branchInput.focus();
  }
  var ticketInput = document.getElementById('ticketTitleInput');
  if (ticketInput) {
    ticketInput.addEventListener('input', function (e) {
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
    prioritySelect.addEventListener('change', function (e) {
      formState.priority = parseInt(e.target.value, 10);
    });
  }
  var teamSelect = document.getElementById('teamSelect');
  if (teamSelect) {
    teamSelect.addEventListener('change', function (e) {
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
    var canSubmit = !formState.submitting && !pendingAction && (
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
    case 'devcontainerYes':
      formState.useDevcontainer = true;
      break;
    case 'devcontainerNo':
      formState.useDevcontainer = false;
      break;
    case 'cancel':
      mode = 'list';
      loadingMessage = null;
      break;
  }
  renderCurrentMode();
}
