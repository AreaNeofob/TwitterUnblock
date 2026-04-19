const state = {
    accounts: [],
    sessionReady: false,
    isResolving: false,
    progressCurrent: 0,
    progressTotal: 0,
    activeFilter: "all",
    sessionMessage: "No X tab checked yet.",
    rateLimitUntil: 0,
    autoResumeAfterRateLimit: false
};

const fileInput = document.getElementById("fileInput");
const resolveBtn = document.getElementById("resolveBtn");
const resetBtn = document.getElementById("resetBtn");
const openXBtn = document.getElementById("openXBtn");
const checkSessionBtn = document.getElementById("checkSessionBtn");
const fileMessage = document.getElementById("fileMessage");
const sessionMessage = document.getElementById("sessionMessage");
const sessionState = document.getElementById("sessionState");
const sessionDot = document.getElementById("sessionDot");
const loadedCount = document.getElementById("loadedCount");
const resolvedCount = document.getElementById("resolvedCount");
const banner = document.getElementById("banner");
const summary = document.getElementById("summary");
const list = document.getElementById("list");
const liveStatus = document.getElementById("liveStatus");
const filterBar = document.getElementById("filterBar");
const filterSelect = document.getElementById("filterSelect");
const saveHtmlBtn = document.getElementById("saveHtmlBtn");
const autoResumeCheckbox = document.getElementById("autoResumeCheckbox");
let rateLimitTimerId = null;

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
    })[char]);
}

function setBanner(message, isError = false) {
    if (!message) {
        banner.hidden = true;
        banner.textContent = "";
        banner.className = "";
        return;
    }

    banner.hidden = false;
    banner.textContent = message;
    banner.className = isError ? "banner error" : "banner";
}

function setLiveStatus(message) {
    liveStatus.textContent = message;
}

function stopRateLimitCountdown() {
    if (rateLimitTimerId) {
        clearInterval(rateLimitTimerId);
        rateLimitTimerId = null;
    }
    state.rateLimitUntil = 0;
    saveAutoResumeState().catch(() => {});
}

function startRateLimitCountdown(waitSeconds) {
    if (rateLimitTimerId) {
        clearInterval(rateLimitTimerId);
        rateLimitTimerId = null;
    }
    state.rateLimitUntil = Date.now() + (waitSeconds * 1000);
    saveAutoResumeState().catch(() => {});

    const updateCountdown = () => {
        const secondsLeft = Math.max(0, Math.ceil((state.rateLimitUntil - Date.now()) / 1000));
        const autoResumeSuffix = state.autoResumeAfterRateLimit ? " Auto-resume is enabled." : "";
        setLiveStatus(`Rate limited by X. You can try again in ${secondsLeft}s.${autoResumeSuffix}`);
        if (secondsLeft <= 0) {
            stopRateLimitCountdown();
            setLiveStatus(
                state.autoResumeAfterRateLimit
                    ? "Rate-limit wait is over. The extension will try to resume automatically."
                    : "Rate-limit wait is over. You can try Resolve Accounts again."
            );
        }
    };

    updateCountdown();
    rateLimitTimerId = setInterval(updateCountdown, 1000);
}

function setBusy(button, busyText, busy) {
    if (!button.dataset.defaultText) {
        button.dataset.defaultText = button.textContent;
    }
    button.disabled = busy;
    button.textContent = busy ? busyText : button.dataset.defaultText;
}

function updateSessionUi() {
    sessionDot.classList.toggle("ready", state.sessionReady);
    sessionState.textContent = state.sessionReady ? "Logged-in X tab ready" : "Session unchecked";
    resolveBtn.disabled = !state.sessionReady || state.accounts.length === 0 || state.isResolving;
}

function updateCounts() {
    loadedCount.textContent = String(state.accounts.length);
    if (state.isResolving && state.progressTotal > 0) {
        resolvedCount.textContent = String(state.progressCurrent);
        return;
    }

    resolvedCount.textContent = String(state.accounts.filter(account => account.resolved).length);
}

function updateSummary() {
    const totals = { blocked: 0, unblocked: 0, deleted: 0, error: 0 };
    state.accounts.forEach(account => {
        if (account.status === "blocked") totals.blocked += 1;
        if (account.status === "already_unblocked") totals.unblocked += 1;
        if (account.status === "deleted") totals.deleted += 1;
        if (account.status === "error") totals.error += 1;
    });

    summary.innerHTML = `
        <div class="stat"><strong>${totals.blocked}</strong><span>Blocked</span></div>
        <div class="stat"><strong>${totals.unblocked}</strong><span>Already unblocked</span></div>
        <div class="stat"><strong>${totals.deleted}</strong><span>Deleted</span></div>
        <div class="stat"><strong>${totals.error}</strong><span>Errors</span></div>
    `;
}

function getVisibleAccounts() {
    if (state.activeFilter === "all") {
        return state.accounts;
    }

    return state.accounts.filter(account => account.status === state.activeFilter);
}

function updateFilterUi() {
    filterSelect.value = state.activeFilter;
}

function updateAutoResumeUi() {
    autoResumeCheckbox.checked = state.autoResumeAfterRateLimit;
}

function filterLabel(filterValue) {
    if (filterValue === "blocked") return "Currently blocked";
    if (filterValue === "already_unblocked") return "Already unblocked";
    if (filterValue === "deleted") return "ACCOUNT DELETED";
    return "All";
}

function saveVisibleAccountsAsHtml() {
    const visibleAccounts = getVisibleAccounts();
    if (visibleAccounts.length === 0) {
        setBanner("There are no visible accounts to save with the current filter.", true);
        return;
    }

    const generatedAt = new Date().toLocaleString("sv-SE");
    const title = `X Block Manager Export - ${filterLabel(state.activeFilter)}`;
    const rows = visibleAccounts.map(account => {
        const displayName = escapeHtml(account.displayName || "");
        const username = account.username ? `@${escapeHtml(account.username)}` : "";
        const detail = escapeHtml(account.detail || "");
        const profileUrl = escapeHtml(account.profileUrl || `https://x.com/i/user/${encodeURIComponent(account.accountId)}`);
        const status = escapeHtml(filterLabel(account.status).replace("All", account.detail || "Unknown"));

        return `
            <article class="item">
                <div class="item-head">
                    <div>
                        <div class="name">${displayName || "Unknown account"}</div>
                        <div class="username">${username}</div>
                        <div class="account-id">ID: ${escapeHtml(account.accountId)}</div>
                    </div>
                    <div class="tag">${escapeHtml(
                        account.status === "blocked"
                            ? "Currently blocked"
                            : account.status === "already_unblocked"
                                ? "Already unblocked"
                                : account.status === "deleted"
                                    ? "ACCOUNT DELETED"
                                    : detail || "Unknown"
                    )}</div>
                </div>
                <div class="detail">${detail}</div>
                <a class="link" href="${profileUrl}">${profileUrl}</a>
            </article>
        `;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
        body { font-family: "Avenir Next", "Segoe UI", sans-serif; margin: 0; background: #eef5f6; color: #102028; }
        main { max-width: 900px; margin: 0 auto; padding: 32px 20px 48px; }
        h1 { margin: 0 0 8px; font-size: 34px; }
        p.meta { margin: 0 0 24px; color: #5d6d75; }
        .item { background: white; border: 1px solid rgba(16, 32, 40, 0.1); border-radius: 18px; padding: 16px; margin-bottom: 12px; }
        .item-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
        .name { font-weight: 800; font-size: 18px; }
        .username, .account-id, .detail, .link { margin-top: 6px; color: #5d6d75; }
        .account-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
        .tag { padding: 6px 10px; border-radius: 999px; background: #e6fffb; color: #115e59; font-size: 12px; font-weight: 700; white-space: nowrap; }
        .link { display: inline-block; color: #0f766e; text-decoration: none; word-break: break-all; }
    </style>
</head>
<body>
    <main>
        <h1>${escapeHtml(title)}</h1>
        <p class="meta">Generated: ${escapeHtml(generatedAt)}<br>Filter: ${escapeHtml(filterLabel(state.activeFilter))}<br>Accounts shown: ${visibleAccounts.length}</p>
        ${rows}
    </main>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const fileSafeFilter = filterLabel(state.activeFilter).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    anchor.href = url;
    anchor.download = `x-block-manager-${fileSafeFilter || "all"}-${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBanner("");
    setLiveStatus(`Saved ${visibleAccounts.length} visible accounts as HTML.`);
}

function statusTag(account) {
    if (account.status === "resolved_preview") {
        return '<span class="tag tag-blocked">Details loaded…</span>';
    }
    if (account.status === "blocked") {
        return '<span class="tag tag-blocked">Currently blocked</span>';
    }
    if (account.status === "already_unblocked") {
        return '<span class="tag tag-unblocked">Already unblocked</span>';
    }
    if (account.status === "deleted") {
        return '<span class="tag tag-deleted">ACCOUNT DELETED</span>';
    }
    return `<span class="tag tag-error">${escapeHtml(account.detail || "Needs review")}</span>`;
}

function renderList() {
    updateCounts();
    updateSummary();
    updateSessionUi();
    updateFilterUi();
    updateAutoResumeUi();

    const visibleAccounts = getVisibleAccounts();

    if (state.accounts.length === 0) {
        list.innerHTML = '<div class="empty">Load your export, open an X tab where you are logged in, and click <strong>Resolve Accounts</strong>. The extension will batch the checks through your logged-in X session without reloading profile pages.</div>';
        return;
    }

    if (visibleAccounts.length === 0) {
        list.innerHTML = '<div class="empty">No accounts match the current filter.</div>';
        return;
    }

    list.innerHTML = visibleAccounts.map(account => {
        const displayName = account.displayName || "Resolving from X…";
        const username = account.username ? `@${account.username}` : "";
        const profileUrl = account.profileUrl || `https://x.com/i/user/${encodeURIComponent(account.accountId)}`;
        const actionDisabled = account.status !== "blocked" || !state.sessionReady;
        const actionLabel = account.status === "already_unblocked"
            ? "Already unblocked"
            : account.status === "deleted"
                ? "Unavailable"
                : account.status === "resolved_preview"
                    ? "Waiting…"
                : account.status === "blocked"
                    ? "Unblock"
                    : "Retry later";

        return `
            <article class="item">
                <div class="item-head">
                    <div>
                        <div class="name">${escapeHtml(displayName)}</div>
                        <div class="username">${escapeHtml(username)}</div>
                        <div class="account-id">
                            ID: ${escapeHtml(account.accountId)}${account.status === "deleted" ? " - ACCOUNT DELETED" : ""}
                        </div>
                    </div>
                    ${statusTag(account)}
                </div>
                <div class="item-actions">
                    <a href="${escapeHtml(profileUrl)}" target="_blank" rel="noopener noreferrer">Open profile</a>
                    <button
                        class="btn ${actionDisabled ? "btn-secondary" : "btn-danger"}"
                        data-action="unblock"
                        data-account-id="${escapeHtml(account.accountId)}"
                        ${actionDisabled ? "disabled" : ""}
                    >${escapeHtml(actionLabel)}</button>
                </div>
            </article>
        `;
    }).join("");
}

function applyPartialAccount(account) {
    const index = state.accounts.findIndex(item => item.accountId === account.accountId);
    if (index === -1) {
        return;
    }

    state.accounts[index] = {
        ...state.accounts[index],
        ...account
    };
    saveAccounts().catch(() => {});
    renderList();
}

async function callWorker(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "Unknown extension error.");
    }
    return response;
}

function parseExport(content) {
    const jsonString = content.replace(/window\.YTD\.block\.part0\s*=\s*/, "").trim();
    const data = JSON.parse(jsonString);
    if (!Array.isArray(data)) {
        throw new Error("The selected file does not look like a Twitter/X block export.");
    }

    return data.map(item => {
        const blocking = item && item.blocking ? item.blocking : {};
        return {
            accountId: String(blocking.accountId || "").trim(),
            userLink: blocking.userLink || "",
            displayName: "",
            username: "",
            profileUrl: blocking.userLink || "",
            status: "error",
            detail: "Not resolved yet",
            resolved: false
        };
    }).filter(item => item.accountId);
}

async function restoreState() {
    const stored = await chrome.storage.local.get([
        "accounts",
        "sessionReady",
        "sessionMessage",
        "activeFilter",
        "rateLimitUntil",
        "autoResumeAfterRateLimit"
    ]);
    state.accounts = Array.isArray(stored.accounts) ? stored.accounts : [];
    state.sessionReady = Boolean(stored.sessionReady);
    state.sessionMessage = stored.sessionMessage || "No X tab checked yet.";
    state.activeFilter = typeof stored.activeFilter === "string" ? stored.activeFilter : "all";
    state.rateLimitUntil = Number(stored.rateLimitUntil || 0);
    state.autoResumeAfterRateLimit = Boolean(stored.autoResumeAfterRateLimit);
    sessionMessage.textContent = state.sessionMessage;
    if (state.rateLimitUntil > Date.now()) {
        startRateLimitCountdown(Math.ceil((state.rateLimitUntil - Date.now()) / 1000));
    } else {
        stopRateLimitCountdown();
    }
    renderList();
}

async function saveAccounts() {
    await chrome.storage.local.set({ accounts: state.accounts });
}

async function saveSessionState() {
    await chrome.storage.local.set({
        sessionReady: state.sessionReady,
        sessionMessage: state.sessionMessage
    });
}

async function saveFilterState() {
    await chrome.storage.local.set({
        activeFilter: state.activeFilter
    });
}

async function saveAutoResumeState() {
    await chrome.storage.local.set({
        autoResumeAfterRateLimit: state.autoResumeAfterRateLimit,
        rateLimitUntil: state.rateLimitUntil || 0
    });
}

async function checkSession() {
    setBanner("");
    try {
        const response = await callWorker("CHECK_SESSION");
        stopRateLimitCountdown();
        state.sessionReady = Boolean(response.ready);
        state.sessionMessage = response.message;
        sessionMessage.textContent = state.sessionMessage;
        await saveSessionState();
        updateSessionUi();
    } catch (error) {
        state.sessionReady = false;
        state.sessionMessage = error.message;
        sessionMessage.textContent = state.sessionMessage;
        await saveSessionState();
        updateSessionUi();
        setBanner(error.message, true);
    }
}

async function resolveAccounts() {
    if (!state.sessionReady || state.accounts.length === 0) {
        return;
    }

    const pendingAccounts = state.accounts.filter(account => !account.resolved);
    if (pendingAccounts.length === 0) {
        setLiveStatus("Nothing to do. All loaded accounts already have saved results.");
        return;
    }

    setBanner("");
    stopRateLimitCountdown();
    state.isResolving = true;
    state.progressCurrent = 0;
    state.progressTotal = pendingAccounts.length;
    setLiveStatus("Preparing requests…");
    updateSessionUi();
    updateCounts();
    setBusy(resolveBtn, "Resolving…", true);

    try {
        const response = await callWorker("RESOLVE_ACCOUNTS", {
            accounts: pendingAccounts.map(({ accountId, userLink }) => ({ accountId, userLink }))
        });
        const byId = new Map(response.accounts.map(account => [account.accountId, account]));
        state.accounts = state.accounts.map(account => ({
            ...account,
            ...(byId.get(account.accountId) || {})
        }));
        await saveAccounts();
        setLiveStatus(`Finished. Resolved ${response.accounts.length} accounts.`);
        renderList();
    } catch (error) {
        setLiveStatus(`Stopped: ${error.message}`);
        setBanner(error.message, true);
    } finally {
        state.isResolving = false;
        state.progressCurrent = 0;
        state.progressTotal = 0;
        setBusy(resolveBtn, "Resolving…", false);
        updateSessionUi();
        updateCounts();
    }
}

async function unblockAccount(accountId, button) {
    const account = state.accounts.find(item => item.accountId === accountId);
    if (!account || account.status !== "blocked") {
        return;
    }

    setBanner("");
    setBusy(button, "Unblocking…", true);

    try {
        const response = await callWorker("UNBLOCK_ACCOUNT", { accountId });
        Object.assign(account, response.account);
        await saveAccounts();
        renderList();
    } catch (error) {
        button.disabled = false;
        button.textContent = button.dataset.defaultText;
        setBanner(error.message, true);
    }
}

openXBtn.addEventListener("click", async () => {
    setBanner("");
    try {
        const response = await callWorker("OPEN_X_TAB");
        state.sessionReady = false;
        state.sessionMessage = response.message;
        sessionMessage.textContent = state.sessionMessage;
        await saveSessionState();
        updateSessionUi();
    } catch (error) {
        setBanner(error.message, true);
    }
});

checkSessionBtn.addEventListener("click", checkSession);

fileInput.addEventListener("change", async event => {
    const file = event.target.files[0];
    if (!file) {
        return;
    }

    setBanner("");
    try {
        const content = await file.text();
        state.accounts = parseExport(content);
        await saveAccounts();
        fileMessage.textContent = `Loaded ${state.accounts.length} accounts from ${file.name}.`;
        renderList();
    } catch (error) {
        state.accounts = [];
        await saveAccounts();
        fileMessage.textContent = error.message;
        renderList();
        setBanner(error.message, true);
    }
});

resolveBtn.addEventListener("click", resolveAccounts);

resetBtn.addEventListener("click", async () => {
    setBanner("");
    state.accounts = [];
    state.sessionReady = false;
    state.sessionMessage = "No X tab checked yet.";
    fileInput.value = "";
    fileMessage.textContent = "Loaded data cleared.";
    sessionMessage.textContent = state.sessionMessage;
    await saveAccounts();
    await saveSessionState();
    renderList();
});

list.addEventListener("click", event => {
    const button = event.target.closest('button[data-action="unblock"]');
    if (!button) {
        return;
    }

    unblockAccount(button.dataset.accountId, button);
});

filterSelect.addEventListener("change", event => {
    state.activeFilter = event.target.value;
    saveFilterState().catch(() => {});
    renderList();
});

autoResumeCheckbox.addEventListener("change", async event => {
    state.autoResumeAfterRateLimit = Boolean(event.target.checked);
    await saveAutoResumeState().catch(() => {});
    try {
        await callWorker("SET_AUTO_RESUME", { enabled: state.autoResumeAfterRateLimit });
    } catch (error) {
        setBanner(error.message, true);
    }
    if (state.rateLimitUntil > Date.now()) {
        startRateLimitCountdown(Math.ceil((state.rateLimitUntil - Date.now()) / 1000));
    } else {
        renderList();
    }
});

saveHtmlBtn.addEventListener("click", saveVisibleAccountsAsHtml);

chrome.runtime.onMessage.addListener(message => {
    if (message.type !== "RESOLVE_PROGRESS") {
        return;
    }

    state.progressCurrent = Number(message.current || 0);
    state.progressTotal = Number(message.total || state.accounts.length || 0);

    if (message.phase === "blocked_ids") {
        stopRateLimitCountdown();
        setLiveStatus("Loading blocked-account IDs from X…");
    } else if (message.phase === "lookup") {
        stopRateLimitCountdown();
        setLiveStatus(`Resolving account ${state.progressCurrent} of ${state.progressTotal}…`);
    } else if (message.phase === "finalizing") {
        stopRateLimitCountdown();
        setLiveStatus("Finalizing results…");
    } else if (message.phase === "rate_limited") {
        startRateLimitCountdown(Number(message.waitSeconds || 0));
    } else if (message.phase === "request") {
        stopRateLimitCountdown();
        setLiveStatus(message.message || "Sending request to X…");
    } else if (message.phase === "request_error") {
        stopRateLimitCountdown();
        setLiveStatus(message.message || "Request failed.");
    }

    updateCounts();
});

chrome.runtime.onMessage.addListener(message => {
    if (message.type !== "RESOLVE_PARTIAL_ACCOUNT") {
        return;
    }

    applyPartialAccount(message.account);
});

chrome.runtime.onMessage.addListener(message => {
    if (message.type !== "AUTO_RESUME_SETTING_CHANGED") {
        return;
    }

    state.autoResumeAfterRateLimit = Boolean(message.enabled);
    saveAutoResumeState().catch(() => {});
    renderList();
});

chrome.runtime.onMessage.addListener(message => {
    if (message.type !== "RESOLVE_COMPLETED") {
        return;
    }

    const resolvedCount = Number(message.resolvedCount || 0);
    setLiveStatus(
        message.autoResumed
            ? `Finished automatically. Resolved ${resolvedCount} accounts.`
            : `Finished. Resolved ${resolvedCount} accounts.`
    );
});

setLiveStatus("Idle.");
restoreState();
renderList();
