const X_HOSTS = ["x.com", "twitter.com"];
const WEB_BEARER_TOKEN = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const USER_BY_REST_ID_QUERY_ID = "CO4_gU4G_MRREoqfiTh6Hg";
const REQUEST_PAUSE_MS = 150;
const REQUEST_TIMEOUT_MS = 15000;
const AUTO_RESUME_ALARM = "autoResumeResolveAccounts";
let sessionTabId = null;
let resolveInProgress = false;
const USER_LOOKUP_FEATURES = {
    hidden_profile_subscriptions_enabled: true,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true
};
const USER_LOOKUP_FIELD_TOGGLES = {
    withAuxiliaryUserLabels: true
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isXUrl(url) {
    try {
        const parsed = new URL(url);
        return X_HOSTS.includes(parsed.hostname);
    } catch (error) {
        return false;
    }
}

function reportResolveProgress(phase, current, total) {
    chrome.runtime.sendMessage({
        type: "RESOLVE_PROGRESS",
        phase,
        current,
        total
    }).catch(() => {});
}

function reportResolveCompleted(resolvedCount, autoResumed = false) {
    chrome.runtime.sendMessage({
        type: "RESOLVE_COMPLETED",
        resolvedCount,
        autoResumed
    }).catch(() => {});
}

async function reportPartialAccount(account) {
    await persistPartialAccount(account);
    chrome.runtime.sendMessage({
        type: "RESOLVE_PARTIAL_ACCOUNT",
        account
    }).catch(() => {});
}

function logWorker(message, extra = "") {
    const suffix = extra ? ` ${extra}` : "";
    console.log(`[x-block-manager] ${message}${suffix}`);
}

function makeRateLimitError(waitSeconds) {
    const error = new Error(`Rate limited by X. Try resolving again in about ${waitSeconds}s.`);
    error.code = "RATE_LIMITED";
    error.waitSeconds = waitSeconds;
    return error;
}

async function getStoredAccounts() {
    const stored = await chrome.storage.local.get(["accounts"]);
    return Array.isArray(stored.accounts) ? stored.accounts : [];
}

async function saveStoredAccounts(accounts) {
    await chrome.storage.local.set({ accounts });
}

async function persistPartialAccount(account) {
    const accounts = await getStoredAccounts();
    const index = accounts.findIndex(item => String(item.accountId) === String(account.accountId));
    if (index === -1) {
        return;
    }

    accounts[index] = {
        ...accounts[index],
        ...account
    };
    await saveStoredAccounts(accounts);
}

async function persistResolvedAccounts(resolvedAccounts) {
    const byId = new Map(resolvedAccounts.map(account => [String(account.accountId), account]));
    const accounts = await getStoredAccounts();
    const updatedAccounts = accounts.map(account => ({
        ...account,
        ...(byId.get(String(account.accountId)) || {})
    }));
    await saveStoredAccounts(updatedAccounts);
}

async function getAutoResumeSettings() {
    const stored = await chrome.storage.local.get(["autoResumeAfterRateLimit", "rateLimitUntil"]);
    return {
        enabled: Boolean(stored.autoResumeAfterRateLimit),
        rateLimitUntil: Number(stored.rateLimitUntil || 0)
    };
}

async function setRateLimitUntil(timestamp) {
    await chrome.storage.local.set({ rateLimitUntil: Number(timestamp || 0) });
}

async function scheduleAutoResume(waitSeconds) {
    const until = Date.now() + (waitSeconds * 1000);
    await setRateLimitUntil(until);

    const settings = await getAutoResumeSettings();
    if (!settings.enabled) {
        return;
    }

    await chrome.alarms.clear(AUTO_RESUME_ALARM);
    chrome.alarms.create(AUTO_RESUME_ALARM, { when: until });
}

async function clearAutoResumeSchedule() {
    await chrome.alarms.clear(AUTO_RESUME_ALARM);
    await setRateLimitUntil(0);
}

async function persistSessionTabId(tabId) {
    sessionTabId = tabId || null;
    await chrome.storage.local.set({ sessionTabId: sessionTabId || null });
}

async function clearPersistedSessionTabId() {
    sessionTabId = null;
    await chrome.storage.local.set({ sessionTabId: null });
}

async function ensureSessionTabIdLoaded() {
    if (sessionTabId !== null) {
        return;
    }

    const stored = await chrome.storage.local.get(["sessionTabId"]);
    sessionTabId = typeof stored.sessionTabId === "number" ? stored.sessionTabId : null;
}

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab || null;
}

async function ensureVisibleXTab() {
    await ensureSessionTabIdLoaded();
    const activeTab = await getActiveTab();
    if (activeTab && activeTab.id && activeTab.url && isXUrl(activeTab.url)) {
        await persistSessionTabId(activeTab.id);
        return activeTab;
    }

    const tab = await chrome.tabs.create({ url: "https://x.com/home", active: true });
    await persistSessionTabId(tab.id || null);
    return await chrome.tabs.get(tab.id);
}

async function getSessionTab() {
    await ensureSessionTabIdLoaded();
    if (sessionTabId) {
        try {
            const savedTab = await chrome.tabs.get(sessionTabId);
            if (savedTab.id && savedTab.url && isXUrl(savedTab.url)) {
                return savedTab;
            }
        } catch (error) {
            await clearPersistedSessionTabId();
        }
    }

    const activeTab = await getActiveTab();
    if (activeTab && activeTab.id && activeTab.url && isXUrl(activeTab.url)) {
        await persistSessionTabId(activeTab.id);
        return activeTab;
    }

    const tabs = await chrome.tabs.query({});
    const existingXTab = tabs.find(tab => tab.id && tab.url && isXUrl(tab.url));
    if (existingXTab) {
        await persistSessionTabId(existingXTab.id);
        return existingXTab;
    }

    throw new Error("Open a logged-in X tab, then click Check X Session again.");
}

async function executeInTab(tabId, func, args = []) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func,
        args
    });

    return results[0] ? results[0].result : null;
}

async function inspectSessionContext(tabId) {
    return await executeInTab(tabId, () => {
        function getCookie(name) {
            const prefix = `${name}=`;
            const match = document.cookie
                .split(";")
                .map(part => part.trim())
                .find(part => part.startsWith(prefix));
            return match ? decodeURIComponent(match.slice(prefix.length)) : "";
        }

        return {
            url: window.location.href,
            hasCt0: Boolean(getCookie("ct0")),
            hasAuthToken: Boolean(getCookie("auth_token")),
            title: document.title || ""
        };
    });
}

async function apiRequest(tabId, request) {
    return await executeInTab(tabId, async ({ url, method, body, bearerToken }) => {
        function getCookie(name) {
            const prefix = `${name}=`;
            const match = document.cookie
                .split(";")
                .map(part => part.trim())
                .find(part => part.startsWith(prefix));
            return match ? decodeURIComponent(match.slice(prefix.length)) : "";
        }

        const csrfToken = getCookie("ct0");
        if (!csrfToken) {
            return { ok: false, status: 0, error: "Could not read the X CSRF token from the current session." };
        }

        const headers = {
            "authorization": bearerToken,
            "x-csrf-token": csrfToken,
            "x-twitter-active-user": "yes",
            "x-twitter-auth-type": "OAuth2Session"
        };

        if (method !== "GET") {
            headers["content-type"] = "application/x-www-form-urlencoded";
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        let response;

        try {
            response = await fetch(url, {
                method,
                credentials: "include",
                headers,
                body: method === "GET" ? undefined : body,
                signal: controller.signal
            });
        } catch (error) {
            clearTimeout(timeoutId);
            return {
                ok: false,
                status: 0,
                error: error && error.name === "AbortError"
                    ? "Request to X timed out."
                    : `Request to X failed: ${error.message || String(error)}`
            };
        }

        clearTimeout(timeoutId);

        let data = null;
        let text = "";
        try {
            data = await response.json();
        } catch (error) {
            text = await response.text().catch(() => "");
        }

        return {
            ok: response.ok,
            status: response.status,
            data,
            text,
            error: "",
            headers: {
                rateLimitReset: response.headers.get("x-rate-limit-reset") || ""
            }
        };
    }, [{ ...request, bearerToken: WEB_BEARER_TOKEN }]);
}

async function waitForRateLimitOrThrow(result) {
    if (result.ok || result.status !== 429) {
        return false;
    }

    const resetHeader = result.headers && result.headers.rateLimitReset;
    if (!resetHeader) {
        throw new Error("X rate-limited the request and did not include a reset time.");
    }

    const waitMs = (Number(resetHeader) * 1000) - Date.now();
    const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    await scheduleAutoResume(waitSeconds);
    reportResolveProgress("rate_limited", 0, 0);
    chrome.runtime.sendMessage({
        type: "RESOLVE_PROGRESS",
        phase: "rate_limited",
        waitSeconds
    }).catch(() => {});
    throw makeRateLimitError(waitSeconds);
}

async function fetchBlockedIds(tabId) {
    reportResolveProgress("blocked_ids", 0, 0);
    logWorker("Fetching blocked IDs");
    const blockedIds = new Set();
    let cursor = "-1";

    while (cursor && cursor !== "0") {
        const url = `https://x.com/i/api/1.1/blocks/ids.json?count=5000&cursor=${encodeURIComponent(cursor)}&stringify_ids=true`;
        reportResolveProgress("request", 0, 0);
        chrome.runtime.sendMessage({
            type: "RESOLVE_PROGRESS",
            phase: "request",
            message: "Requesting blocked-account IDs from X…"
        }).catch(() => {});
        const result = await apiRequest(tabId, { url, method: "GET" });

        if (result.error) {
            logWorker("Blocked IDs request failed", result.error);
            chrome.runtime.sendMessage({
                type: "RESOLVE_PROGRESS",
                phase: "request_error",
                message: result.error
            }).catch(() => {});
            throw new Error(result.error);
        }

        await waitForRateLimitOrThrow(result);

        if (!result.ok) {
            throw new Error(`Could not load your current blocked-account IDs from X (${result.status}).`);
        }

        const payload = result.data || {};
        const ids = Array.isArray(payload.ids) ? payload.ids : [];
        ids.forEach(id => blockedIds.add(String(id)));
        cursor = payload.next_cursor_str || "0";
        await delay(REQUEST_PAUSE_MS);
    }

    return blockedIds;
}

function makeDeletedAccount(accountId) {
    return {
        accountId,
        displayName: "",
        username: "",
        profileUrl: `https://x.com/i/user/${encodeURIComponent(accountId)}`,
        status: "deleted",
        detail: "ACCOUNT DELETED",
        resolved: true
    };
}

function makeErroredAccount(accountId, detail) {
    return {
        accountId,
        displayName: accountId,
        username: "",
        profileUrl: `https://x.com/i/user/${encodeURIComponent(accountId)}`,
        status: "error",
        detail,
        resolved: true
    };
}

function makeResolvedAccount(accountId, user, blockedIds) {
    const username = user.screen_name || "";
    const blocked = blockedIds.has(accountId);

    return {
        accountId,
        displayName: user.name || accountId,
        username,
        profileUrl: username
            ? `https://x.com/${encodeURIComponent(username)}`
            : `https://x.com/i/user/${encodeURIComponent(accountId)}`,
        status: blocked ? "blocked" : "already_unblocked",
        detail: blocked ? "Currently blocked" : "Already unblocked",
        resolved: true
    };
}

function makeOptimisticUnblockedAccount(account) {
    const accountId = String(account.accountId);
    const username = account.username || "";

    return {
        accountId,
        displayName: account.displayName || accountId,
        username,
        profileUrl: account.profileUrl || (
            username
                ? `https://x.com/${encodeURIComponent(username)}`
                : `https://x.com/i/user/${encodeURIComponent(accountId)}`
        ),
        status: "already_unblocked",
        detail: "Already unblocked",
        resolved: true
    };
}

async function fetchUsersLookup(tabId, accountIds, blockedIds) {
    const usersById = new Map();
    const missingIds = new Set();
    const erroredIds = new Map();
    const total = accountIds.length;

    for (let index = 0; index < accountIds.length; index += 1) {
        const accountId = accountIds[index];
        reportResolveProgress("lookup", index + 1, total);
        const query = new URLSearchParams({
            variables: JSON.stringify({
                userId: accountId,
                withSafetyModeUserFields: true,
                withGrokTranslatedBio: false
            }),
            features: JSON.stringify(USER_LOOKUP_FEATURES),
            fieldToggles: JSON.stringify(USER_LOOKUP_FIELD_TOGGLES)
        });

        const result = await apiRequest(tabId, {
            url: `https://x.com/i/api/graphql/${USER_BY_REST_ID_QUERY_ID}/UserByRestId?${query.toString()}`,
            method: "GET"
        });

        if (result.error) {
            logWorker("User lookup request failed", `${accountId} ${result.error}`);
            chrome.runtime.sendMessage({
                type: "RESOLVE_PROGRESS",
                phase: "request_error",
                message: `Lookup failed for ${accountId}: ${result.error}`
            }).catch(() => {});
            throw new Error(result.error);
        }

        await waitForRateLimitOrThrow(result);

        if (!result.ok) {
            logWorker("User lookup non-OK", `${accountId} status=${result.status}`);
            if (result.status === 404) {
                missingIds.add(accountId);
                await reportPartialAccount(makeDeletedAccount(accountId));
                await delay(REQUEST_PAUSE_MS);
                continue;
            }

            const erroredAccount = makeErroredAccount(
                accountId,
                `Could not look up account details from X (${result.status}).`
            );
            erroredIds.set(accountId, erroredAccount.detail);
            await reportPartialAccount(erroredAccount);
            await delay(REQUEST_PAUSE_MS);
            continue;
        }

        const userResult = result.data && result.data.data && result.data.data.user
            ? result.data.data.user.result
            : null;

        if (!userResult) {
            missingIds.add(accountId);
            await reportPartialAccount(makeDeletedAccount(accountId));
            await delay(REQUEST_PAUSE_MS);
            continue;
        }

        if (userResult.__typename && userResult.__typename !== "User") {
            missingIds.add(accountId);
            await reportPartialAccount(makeDeletedAccount(accountId));
            await delay(REQUEST_PAUSE_MS);
            continue;
        }

        const legacy = userResult.legacy || {};
        const resolvedId = String(userResult.rest_id || accountId);
        usersById.set(resolvedId, {
            id_str: resolvedId,
            name: legacy.name || "",
            screen_name: legacy.screen_name || ""
        });

        await reportPartialAccount(
            makeResolvedAccount(resolvedId, {
                name: legacy.name || "",
                screen_name: legacy.screen_name || ""
            }, blockedIds)
        );

        await delay(REQUEST_PAUSE_MS);
    }

    return { usersById, missingIds, erroredIds };
}

async function unblockById(tabId, accountId) {
    logWorker("Unblocking account", accountId);
    const result = await apiRequest(tabId, {
        url: "https://x.com/i/api/1.1/blocks/destroy.json",
        method: "POST",
        body: `user_id=${encodeURIComponent(accountId)}`
    });

    if (result.error) {
        throw new Error(result.error);
    }

    if (await waitForRateLimitOrThrow(result)) {
        return await unblockById(tabId, accountId);
    }

    if (!result.ok) {
        throw new Error(`Could not unblock this account on X (${result.status}).`);
    }

    return result.data || {};
}

async function checkSession() {
    const tab = await getSessionTab();
    if (!tab.id) {
        throw new Error("Could not access the current X tab.");
    }

    sessionTabId = tab.id;
    await persistSessionTabId(tab.id);

    if (!tab.url || !isXUrl(tab.url)) {
        throw new Error("Switch to a logged-in X tab and try again.");
    }

    if (tab.url.includes("/login") || tab.url.includes("/i/flow/login")) {
        return {
            ready: false,
            message: "The current X tab is not logged in yet."
        };
    }

    const context = await inspectSessionContext(tab.id);
    if (context && context.url && (context.url.includes("/login") || context.url.includes("/i/flow/login"))) {
        return {
            ready: false,
            message: "The current X tab is not logged in yet."
        };
    }

    if (context && context.hasCt0 && context.hasAuthToken) {
        return {
            ready: true,
            message: "Logged-in X session looks ready."
        };
    }

    const probe = await apiRequest(tab.id, {
        url: "https://x.com/i/api/1.1/blocks/ids.json?count=1&cursor=-1&stringify_ids=true",
        method: "GET"
    });

    if (probe.error || !probe.ok) {
        return {
            ready: false,
            message: "The current X tab does not appear to have a usable logged-in X session."
        };
    }

    return {
        ready: true,
        message: "Logged-in X session is ready. Account checks will now run by direct request without page reloads."
    };
}

function buildResolvedAccount(accountId, user, blockedIds, missingIds, erroredIds) {
    if (erroredIds.has(accountId)) {
        return makeErroredAccount(accountId, erroredIds.get(accountId));
    }

    if (missingIds.has(accountId) || !user) {
        return makeDeletedAccount(accountId);
    }

    return makeResolvedAccount(accountId, user, blockedIds);
}

async function resolveAccounts(tabId, accounts) {
    const accountIds = accounts.map(account => String(account.accountId));
    const blockedIds = await fetchBlockedIds(tabId);
    const lookupResult = await fetchUsersLookup(tabId, accountIds, blockedIds);
    const { usersById, missingIds, erroredIds } = lookupResult;
    reportResolveProgress("finalizing", accountIds.length, accountIds.length);

    return accountIds.map(accountId =>
        buildResolvedAccount(accountId, usersById.get(accountId), blockedIds, missingIds, erroredIds)
    );
}

async function runResolve(accounts, autoResumed = false) {
    if (resolveInProgress) {
        throw new Error("A resolve run is already in progress.");
    }

    resolveInProgress = true;
    await clearAutoResumeSchedule();

    try {
        const tab = await getSessionTab();
        if (!tab.id) {
            throw new Error("Could not access the logged-in X tab.");
        }

        const session = await checkSession();
        if (!session.ready) {
            throw new Error(session.message);
        }

        const resolvedAccounts = await resolveAccounts(tab.id, accounts);
        await persistResolvedAccounts(resolvedAccounts);
        await clearAutoResumeSchedule();
        reportResolveCompleted(resolvedAccounts.length, autoResumed);
        return resolvedAccounts;
    } finally {
        resolveInProgress = false;
    }
}

async function runAutoResumeResolve() {
    const settings = await getAutoResumeSettings();
    if (!settings.enabled) {
        return;
    }

    const accounts = await getStoredAccounts();
    const pendingAccounts = accounts
        .filter(account => !account.resolved)
        .map(({ accountId, userLink }) => ({ accountId, userLink }));

    if (pendingAccounts.length === 0) {
        await clearAutoResumeSchedule();
        return;
    }

    logWorker("Auto-resuming resolve run", `${pendingAccounts.length} unresolved accounts`);
    try {
        await runResolve(pendingAccounts, true);
    } catch (error) {
        logWorker("Auto-resume resolve failed", error.message || String(error));
        if (error.code !== "RATE_LIMITED") {
            chrome.runtime.sendMessage({
                type: "RESOLVE_PROGRESS",
                phase: "request_error",
                message: `Auto-resume failed: ${error.message || String(error)}`
            }).catch(() => {});
        }
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        if (message.type === "OPEN_X_TAB") {
            const tab = await ensureVisibleXTab();
            sendResponse({
                ok: true,
                message: tab.url && isXUrl(tab.url)
                    ? "X tab opened. Log in there if needed, then come back and check the session."
                    : "X tab opened."
            });
            return;
        }

        if (message.type === "CHECK_SESSION") {
            const result = await checkSession();
            sendResponse({ ok: true, ...result });
            return;
        }

        if (message.type === "RESOLVE_ACCOUNTS") {
            const accounts = await runResolve(message.accounts || []);
            sendResponse({ ok: true, accounts });
            return;
        }

        if (message.type === "SET_AUTO_RESUME") {
            await chrome.storage.local.set({
                autoResumeAfterRateLimit: Boolean(message.enabled)
            });
            chrome.runtime.sendMessage({
                type: "AUTO_RESUME_SETTING_CHANGED",
                enabled: Boolean(message.enabled)
            }).catch(() => {});

            if (!message.enabled) {
                await chrome.alarms.clear(AUTO_RESUME_ALARM);
            } else {
                const settings = await getAutoResumeSettings();
                if (settings.rateLimitUntil > Date.now()) {
                    await chrome.alarms.clear(AUTO_RESUME_ALARM);
                    chrome.alarms.create(AUTO_RESUME_ALARM, { when: settings.rateLimitUntil });
                }
            }

            sendResponse({ ok: true });
            return;
        }

        if (message.type === "UNBLOCK_ACCOUNT") {
            const tab = await getSessionTab();
            if (!tab.id) {
                throw new Error("Could not access the logged-in X tab.");
            }

            const session = await checkSession();
            if (!session.ready) {
                throw new Error(session.message);
            }

            await unblockById(tab.id, message.accountId);
            const storedAccounts = await getStoredAccounts();
            const currentAccount = storedAccounts.find(account => String(account.accountId) === String(message.accountId));
            const updatedAccount = makeOptimisticUnblockedAccount(
                currentAccount || { accountId: String(message.accountId) }
            );
            await persistPartialAccount(updatedAccount);
            sendResponse({ ok: true, account: updatedAccount });
            return;
        }

        sendResponse({ ok: false, error: "Unknown extension message." });
    })().catch(error => {
        logWorker("Unhandled worker error", error.message || String(error));
        sendResponse({
            ok: false,
            error: error.message || String(error),
            code: error.code || "",
            waitSeconds: error.waitSeconds || 0
        });
    });

    return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
    if (tabId === sessionTabId) {
        clearPersistedSessionTabId().catch(() => {});
    }
});

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== AUTO_RESUME_ALARM) {
        return;
    }

    runAutoResumeResolve().catch(error => {
        logWorker("Auto-resume alarm failed", error.message || String(error));
    });
});
