// ==UserScript==
// @name         菜鸟销退单：从售后表逐单创建
// @namespace    znext.local.cainiao-returns
// @version      1.6.7
// @description  从售后表准备菜鸟小批导出，匹配未建售后并逐单创建销退单
// @match        https://b.cainiao.com/business/import/perform/taobao-fulfillment/*
// @grant        none
// @run-at       document-idle
// @updateURL   none
// @downloadURL none
// @homepageURL https://github.com/grin-gitx/cainiao-returns-assistant
// ==/UserScript==

(() => {
  "use strict";

  const BASE = "https://b.cainiao.com/business/import/perform/taobao-fulfillment";
  const ORDER_URL = `${BASE}/ordermgmt-new`;
  const CREATE_URL = `${BASE}/sales-return-add`;
  const RETURN_URL = `${BASE}/sales-return-mgmt`;
  const STATE_KEY = "znext-cainiao-returns-v1";
  const EXECUTION_KEY = 'znext-cainiao-execution-v1';
  const LOCK_NAME = 'znext-cainiao-returns-execution';
  const nameMarker = '|znext-cainiao-tab:';
  const TAB_ID_KEY = 'znext-cainiao-tab-id-v1';
  // Session identity survives Cainiao rewriting window.name during same-origin navigation.
  // Copies can inherit this identity; Web Locks and shared revisions still guard execution.
  let tabId = sessionStorage.getItem(TAB_ID_KEY) || window.name.split(nameMarker)[1] || crypto.randomUUID();
  sessionStorage.setItem(TAB_ID_KEY, tabId);
  const documentId = crypto.randomUUID();
  let busy = false;
  let executing = false;
  function executionOwner() {
    try { return JSON.parse(localStorage.getItem(EXECUTION_KEY) || 'null'); }
    catch { throw new PauseError('无法读取跨标签执行归属，已安全停止'); }
  }
  function importIdentity(state) {
    const current = loadState();
    if (!current || current.id !== state.id || current.runToken !== state.runToken ||
        current.stage !== 'prep_files' || current.active) throw new Error('批次已变化，已丢弃旧文件读取结果');
  }
  const PANEL_KEY = "znext-cainiao-returns-panel-open";
  // Conservative local settings; these are not Cainiao-published rate limits.
  const ACTION_INTERVAL_MS = 1500;
  const BETWEEN_ORDERS_MS = 2000;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const HEADERS = ["售后编号", "订单编号", "原发货LP", "退货运单号", "状态", "销退交易单号", "销退单号", "说明", "处理时间"];
  const ALIASES = {
    aftersale: ["售后编号", "售后单号"],
    order: ["订单编号", "订单号", "拼多多订单号"],
    waybill: ["退货运单号", "退货单号", "退货物流单号"],
    sku: ["sku信息", "SKU", "商品SKU", "规格"],
    quantity: ["退货数量", "数量", "需退货数量"],
    refundType: ["退款类型"],
    aftersaleStatus: ["售后状态"],
    lp: ["原发货LP", "LP单号"],
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").trim();
  const skuKey = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const shown = (element) => !!element && element.getClientRects().length > 0;
  const message = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);

  const PDD_ORDER = /^\d{6}-\d{15}$/;
  const bindingSnapshot = (job) => JSON.stringify([job.aftersale, job.order, job.waybill,
    (job.items || []).map((item) => [item.sku, item.quantity ?? null])]);
  const mappingSnapshot = (job) => JSON.stringify([job.lp || '', (job.items || []).map((item) => [item.sku, item.quantity ?? null, item.goodsId || ''])]);
  function bindingIssues(job, peers = []) {
    const issues = [];
    const order = clean(job?.order), aftersale = clean(job?.aftersale), waybill = clean(job?.waybill);
    if (!PDD_ORDER.test(order)) issues.push('原订单编号不是有效拼多多订单格式');
    if (!/^\d+$/.test(aftersale)) issues.push('售后编号不是有效数字编号');
    const identities = new Set([order, aftersale, ...peers.flatMap((row) => [clean(row.order), clean(row.aftersale)])]);
    if (!waybill) issues.push('退货运单号为空');
    else if (identities.has(waybill) || PDD_ORDER.test(waybill) || /^(?:LP|GPL|ROMS)\d+$/i.test(waybill)) {
      issues.push('退货运单号误填原订单、售后编号或系统单号，请核实同一售后行的真实快递单号');
    } else if (waybill.length < 6 || waybill.length > 128 || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/i.test(waybill) || !/\d/.test(waybill)) {
      issues.push('退货运单号含多单号、异常字符或明显无效内容，请核实真实快递单号');
    }
    if (!Array.isArray(job?.items) || !job.items.length) issues.push('售后货品缺失');
    else {
      const keys = new Set(), goods = new Set();
      for (const item of job.items) {
        const key = skuKey(item.sku);
        if (!key || keys.has(key)) issues.push('售后 SKU 为空或重复');
        keys.add(key);
        if (item.quantity != null && (!Number.isSafeInteger(item.quantity) || item.quantity <= 0)) issues.push('退货数量超出有效正整数范围');
        if (item.goodsId && (!/^\d+$/.test(item.goodsId) || goods.has(item.goodsId))) issues.push('售后货品 ID 无效或重复');
        if (item.goodsId) goods.add(item.goodsId);
      }
    }
    if (job?.sourceBinding && job.sourceBinding.snapshot !== bindingSnapshot(job)) issues.push('本单订单、运单或货品已偏离原售后行，请重新导入原三表');
    if (job?.mappingBinding && job.mappingBinding !== mappingSnapshot(job)) issues.push('本单原 LP 或货品映射已偏离匹配记录，请重新导入原三表');
    if (job?.bindingConflict) issues.push('相同售后编号的原行配对不一致');
    return [...new Set(issues)];
  }
  function assertJobBinding(state, requireSource = false) {
    const job = state.jobs?.[state.index];
    if (!job) throw new PauseError('当前售后任务缺失');
    const issues = [...bindingIssues(job, state.jobs || []), job.issue].filter(Boolean);
    if (requireSource && !job.sourceBinding) issues.push('旧任务缺少原售后行绑定记录，请重新选择原三表核对；已提交记录仍禁止重提');
    if (state.lp && job.lp && state.lp !== job.lp) issues.push('当前原发货 LP 与本单绑定不一致');
    if (issues.length) throw new PauseError([...new Set(issues)].join('；'));
  }

  function loadState() {
    try {
      return JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
    } catch {
      return null;
    }
  }

  function saveState(state) {
    if (executing) {
      const owner = executionOwner();
      if (!owner || owner.tabId !== tabId || owner.id !== state.id) throw new PauseError('执行归属已变化，停止旧标签写入');
      state.executionRevision = (owner.revision || 0) + 1;
      localStorage.setItem(EXECUTION_KEY, JSON.stringify({ tabId, id: state.id,
        revision: state.executionRevision, active: state.active, checkpoint: state }));
    }
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    render();
  }

  async function waitFor(check, label, timeout = 20000, state = null) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (state) assertActive(state);
      const value = check();
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`等待“${label}”超时`);
  }

  function assertRunning(state) {
    const owner = executionOwner();
    if (owner?.active && (owner.tabId !== tabId || owner.id !== state.id)) throw new PauseError('此批次由另一标签页执行；请回到执行标签，或停止后显式接管');
    const current = loadState();
    if (!current?.active || current.id !== state.id || current.runToken !== state.runToken) throw new Error("用户已停止处理");
  }

  function assertActive(state) {
    assertRunning(state);
    assertPageSafe();
  }

  class PauseError extends Error {}
  class BusinessIssue extends Error {
    constructor(code, reason) { super(reason); this.code = code; }
  }
  const BUSINESS_CODES = new Set(['no_forward_order', 'no_original_order', 'order_ineligible', 'goods_unavailable', 'quantity_missing', 'quantity_insufficient', 'return_conflict']);
  function cleanJobTemporary(state) {
    state.lp = ''; state.addressNote = ''; state.waitLabel = '';
    for (const key of ['addressAudit', 'submission', 'forceFreshVerification', 'lookupOrder', 'formAudit', 'resultAudit', 'queryDiagnostics', 'createConfirmationPending']) delete state[key];
  }
  function submissionEvidence(state) {
    const job = state.jobs?.[state.index];
    if (!job) return '当前任务不存在';
    if (state.submission || state.createConfirmationPending || state.stage === 'verify' || state.resumeStage === 'verify') return '当前单已提交或提交状态不明';
    const rows = (state.results || []).filter((row) => resultKey(row) === resultKey([job.aftersale, job.order, '', job.waybill]));
    if (rows.some((row) => ['已创建', '需人工核实'].includes(row[4]) || /ROMS\d+/i.test(String(row[5] || '')))) return '当前单已有成功、提交不明或销退单号记录';
    if (confirmationDialog()) return '页面仍有创建确认弹窗';
    if (/^ROMS\d+$/i.test(clean(new URL(location.href).searchParams.get('orderCode')))) return '当前页面仍显示销退提交结果';
    return '';
  }
  function batchOutcome(state) {
    const keys = new Set((state.jobs || []).slice(0, state.jobLimit ?? state.jobs.length).map((job) => resultKey([job.aftersale, job.order, '', job.waybill])));
    const counts = { created: 0, deferred: 0, skipped: 0, existing: 0, uncertain: 0 };
    for (const row of normalizeResults(state.results || [])) {
      if (!keys.has(resultKey(row))) continue;
      if (row[4] === '已创建') counts.created++;
      else if (row[4] === '待人工处理') counts.deferred++;
      else if (row[4] === '人工跳过') counts.skipped++;
      else if (row[4] === '已建跳过') counts.existing++;
      else if (['需核实', '需人工核实'].includes(row[4])) counts.uncertain++;
    }
    return counts;
  }
  const skipTicket = (state) => JSON.stringify([state.id, state.index, state.executionRevision || 0, state.runToken || '',
    state.jobs?.[state.index]?.aftersale, state.jobs?.[state.index]?.order, state.jobs?.[state.index]?.waybill]);
  async function manualSkip(ticket, reason) {
    reason = clean(reason);
    if (!reason) throw new PauseError('请填写本次人工跳过原因');
    if (!navigator.locks?.request || sessionStorage.getItem(TAB_ID_KEY) !== tabId) throw new PauseError('当前环境无法可靠锁定执行归属，未跳过');
    let changed = false;
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) throw new PauseError('另一标签正在执行，未跳过当前单');
      const current = loadState(), owner = executionOwner();
      if (!current || current.active || current.flow === 'prepare' || !['paused', 'stopped'].includes(current.stage) || skipTicket(current) !== ticket) throw new PauseError('当前批次或任务已变化，未跳过；请重新核对');
      if (owner && (owner.id !== current.id || owner.active || (owner.revision || 0) !== (current.executionRevision || 0) || !owner.checkpoint || skipTicket(owner.checkpoint) !== ticket || owner.checkpoint.active || !['paused', 'stopped'].includes(owner.checkpoint.stage))) throw new PauseError('共享最新进度或执行归属与当前任务不一致，未跳过');
      const state = structuredClone(owner?.checkpoint || current);
      assertPageSafe(); assertJobBinding(state, true);
      const evidence = submissionEvidence(state);
      if (evidence) throw new PauseError(`${evidence}，禁止跳过；请先核对后台结果`);
      // The confirmation refers to this exact snapshot; commit once under the same lock.
      record(state, '人工跳过', `仅本批次人工跳过：${reason}；下次导入仍会检查`);
      state.index++;
      cleanJobTemporary(state);
      state.active = false; state.runToken = crypto.randomUUID();
      state.notBefore = Date.now() + BETWEEN_ORDERS_MS;
      if (state.index >= (state.jobLimit ?? state.jobs.length)) { state.stage = 'done'; delete state.resumeStage; state.pauseReason = ''; }
      else { state.stage = 'paused'; state.resumeStage = 'cooldown'; state.pauseReason = '上一单已人工跳过；已停在下一单，点击“从最新进度继续”才会处理'; }
      state.executionRevision = (owner?.revision || current.executionRevision || 0) + 1;
      localStorage.setItem(EXECUTION_KEY, JSON.stringify({ tabId, id: state.id, revision: state.executionRevision, active: false, checkpoint: state }));
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state)); render(); changed = true;
      if (state.stage === 'done') csvDownload(state);
    });
    return changed;
  }
  async function requestManualSkip() {
    const state = loadState();
    if (busy || !state || state.active || state.flow === 'prepare' || !['paused', 'stopped'].includes(state.stage)) return;
    const ticket = skipTicket(state), job = state.jobs?.[state.index];
    if (!job) return;
    try { assertPageSafe(); const evidence = submissionEvidence(state); if (evidence) throw new PauseError(evidence + '，禁止跳过'); }
    catch (error) { alert(message(error)); return; }
    busy = true; render();
    try {
      if (!confirm(`跳过当前订单 ${job.order}\n退货运单 ${job.waybill}\n仅本批次跳过；下次导入仍会检查。请确认其他执行标签已停止。跳过后停在下一单，点击继续才会处理。现在跳过？`)) return;
      const reason = prompt('请填写人工跳过原因（必填，例如：无需退货或需另行处理）');
      if (!clean(reason)) return;
      await manualSkip(ticket, reason);
    } catch (error) { alert(`未跳过：${message(error)}`); }
    finally { busy = false; render(); }
  }

  function assertPageSafe() {
    const notices = visibleAll('[role="alert"], [role="alertdialog"], .cn-next-message, .cn-next-dialog')
      .filter((item) => !item.closest('#znext-cainiao-panel'))
      .map((item) => clean(item.innerText)).join(' ');
    if (/操作.{0,6}频繁|请求.{0,6}频繁|访问.{0,6}频繁|限流|访问受限|Too Many Requests/i.test(notices)) {
      throw new PauseError('页面提示操作频繁、限流或访问受限；已停止后续请求');
    }
    if (/安全验证|人机验证|请.{0,8}完成验证|验证码|滑动.{0,8}验证/.test(notices) ||
        visibleAll('.nc-container, .nc_wrapper, #nc_1_wrapper, [id*="captcha"], iframe[src*="captcha"]')
          .some((item) => !item.closest('#znext-cainiao-panel'))) {
      throw new PauseError('页面出现验证码或安全验证，请人工处理；脚本不会重试或继续提交');
    }
    if (/登录失效|登录.{0,5}过期|请重新登录|会话.{0,5}过期/.test(notices) ||
        visibleAll('input[type="password"]').length > 0) {
      throw new PauseError('页面提示登录失效，请先人工登录');
    }
  }

  async function delayUntil(state, until, label) {
    if (Date.now() >= until) {
      assertActive(state);
      return;
    }
    state.waitLabel = label;
    saveState(state);
    try {
      while (Date.now() < until) {
        assertActive(state);
        await sleep(Math.min(250, until - Date.now()));
      }
      assertActive(state);
    } finally {
      state.waitLabel = '';
      const current = loadState();
      if (current?.active && current.id === state.id && current.runToken === state.runToken) saveState(state);
    }
  }

  async function pace(state) {
    await delayUntil(state, (state.lastActionAt || 0) + ACTION_INTERVAL_MS, '等待操作间隔');
    state.lastActionAt = Date.now();
    saveState(state);
  }

  function pause(state, reason) {
    state.active = false;
    state.resumeStage = state.stage;
    state.stage = 'paused';
    state.pauseReason = reason;
    saveState(state);
    if (state.results.length) {
      try { csvDownload(state); }
      catch (error) { state.pauseReason += `；结果无法合并：${message(error)}`; saveState(state); }
    }
  }

  async function cooldown(state) {
    await delayUntil(state, state.notBefore || 0, '等待下一单');
    setJobStage(state);
    saveState(state);
    location.assign(state.stage === 'create' ? CREATE_URL : ORDER_URL);
  }

  function setJobStage(state) {
    state.lp = state.jobs[state.index]?.lp || '';
    state.stage = state.lp ? 'create' : 'lookup';
  }

  function visibleAll(selector) {
    return [...document.querySelectorAll(selector)].filter(shown);
  }

  function visibleText(selector, exactText) {
    return visibleAll(selector).find((element) =>
      clean(element.innerText || element.textContent) === exactText);
  }

  function fieldGroup(label) {
    return visibleAll(".form-item").find((element) =>
      clean(element.innerText).includes(label));
  }

  function addressGroup(label) {
    return visibleAll('.form-item').find((element) =>
      clean(element.querySelector('.form-item-title')?.innerText).replace(/^\*/, '') === label);
  }

  function selectedAddress(label) {
    const group = addressGroup(label);
    const control = group?.querySelector('[role="combobox"]');
    const aria = control?.getAttribute('aria-valuetext');
    const value = clean(aria === null || aria === undefined ? group?.querySelector('em')?.innerText : aria);
    return /^(请选择|请先选择|加载中|没有数据|暂无数据|无数据)/.test(value) ? '' : value;
  }

  function addressControl(label) {
    const control = addressGroup(label)?.querySelector('[role="combobox"]');
    return shown(control) ? control : null;
  }

  function addressDetail() {
    const control = addressGroup('详细地址')?.querySelector('input,textarea');
    return shown(control) ? control : null;
  }

  function addressStableCheck(read, hold = 750) {
    let previous = [], since = 0;
    return () => {
      const current = read();
      if (!current) { previous = []; since = 0; return false; }
      if (current.length !== previous.length || current.some((value, index) => value !== previous[index])) {
        previous = current; since = Date.now(); return false;
      }
      return Date.now() - since >= hold ? current : false;
    };
  }

  function assertAddressPreserved(state, complete = true) {
    const audit = state.addressAudit, job = state.jobs[state.index];
    if (!audit || audit.batchId !== state.id || audit.jobIndex !== state.index || audit.aftersale !== job?.aftersale) {
      throw new PauseError('本单默认地址核对记录缺失，请人工核实');
    }
    if (!addressControl('省') || !addressDetail() || selectedAddress('省') !== audit.province || addressDetail().value !== audit.detail) {
      throw new PauseError('默认省或详细地址发生变化，请人工核实');
    }
    if (complete && (!addressControl('市') || !addressControl('区') ||
        selectedAddress('市') !== audit.city || selectedAddress('区') !== audit.district)) {
      throw new PauseError('本单市区地址发生变化，请人工核实');
    }
  }

  // Retain the existing helper name for callers; complete a missing city before its dependent district.
  async function completeDistrict(state) {
    const initialStarted = Date.now();
    const defaults = await waitFor(addressStableCheck(() => {
      const province = addressControl('省'), city = addressControl('市'), detail = addressDetail();
      if (!province || !city || !detail) return false;
      // Give asynchronous defaults the full loading window before treating a city as absent.
      if (Date.now() - initialStarted < 8000 && (!selectedAddress('省') || !selectedAddress('市'))) return false;
      return [province, city, detail, selectedAddress('省'), selectedAddress('市'), detail.value];
    }), '默认省市和详细地址稳定', 15000, state);
    if (!defaults[3]) throw new PauseError('默认省未带出，请人工选择省后再处理');
    const job = state.jobs[state.index];
    state.addressAudit = { batchId: state.id, jobIndex: state.index, aftersale: job?.aftersale,
      province: defaults[3], city: defaults[4], detail: defaults[5], district: '' };
    const guard = (city = '') => {
      assertAddressPreserved(state, false);
      if (city && selectedAddress('市') !== city) throw new PauseError('当前城市发生变化，请人工核实');
    };
    const readyControl = (label, city = '', refreshed = () => true) => addressStableCheck(() => {
      guard(city);
      const control = addressControl(label);
      if (!refreshed() || !control || control.disabled || control.getAttribute('aria-disabled') === 'true' ||
          control.getAttribute('aria-busy') === 'true' || addressGroup(label)?.getAttribute('aria-busy') === 'true') return false;
      return [control, selectedAddress(label), city && addressControl('市')];
    });
    const selectFirst = async (label, city = '') => {
      await pace(state);
      const [control] = await waitFor(readyControl(label, city), `当前${label}控件稳定`, 10000, state);
      const alreadyOpen = new Set(visibleAll('[role="listbox"]'));
      guard(city);
      control.click();
      const chosen = await waitFor(addressStableCheck(() => {
        guard(city);
        if (addressControl(label) !== control) throw new PauseError(`${label}选择框已更新，请核实后继续`);
        const lists = visibleAll('[role="listbox"]').filter((list) => !alreadyOpen.has(list));
        const linked = clean(control.getAttribute('aria-controls') || control.getAttribute('aria-owns'));
        const menus = linked ? lists.filter((list) => linked.split(/\s+/).includes(list.id)) : lists;
        if (menus.length !== 1) return false;
        const list = menus[0];
        if (list.getAttribute('aria-busy') === 'true') return false;
        const option = [...list.querySelectorAll('[role="option"]')].find((item) =>
          shown(item) && !item.closest('[aria-disabled="true"],[disabled],.cn-next-disabled,.cn-next-menu-item-disabled') &&
          clean(item.innerText) && !/^(请选择|请先选择|加载中|没有数据|暂无数据|无数据)/.test(clean(item.innerText)));
        return option ? [list, option, clean(option.innerText)] : false;
      }), `当前${label}的有效选项（无可选项请人工核实）`, 10000, state);
      await pace(state);
      guard(city);
      if (addressControl(label) !== control || !shown(chosen[0]) || !shown(chosen[1]) ||
          !chosen[0].contains(chosen[1]) || clean(chosen[1].innerText) !== chosen[2] ||
          chosen[1].closest('[aria-disabled="true"],[disabled],.cn-next-disabled,.cn-next-menu-item-disabled')) {
        throw new PauseError(`${label}选项已变化，请人工核实`);
      }
      if (label === '市') { cityChosen = true; districtUpdated = !oldDistrict; }
      chosen[1].click();
      await waitFor(addressStableCheck(() => {
        guard();
        const current = addressControl(label);
        return current && selectedAddress(label) === chosen[2] ? [current, selectedAddress(label)] : false;
      }), `补选${label}结果稳定`, 10000, state);
      return chosen[2];
    };
    let city = defaults[4], addedCity = false, addedDistrict = false;
    let districtUpdated = !addressControl('区');
    const oldDistrict = addressControl('区');
    let observer, cityChosen = false;
    try {
      if (!city) {
        // Do not reuse a district control/value left over from before choosing the city.
        observer = new MutationObserver((records) => {
          if (cityChosen && records.some((record) => {
            const group = addressGroup('区');
            return group && (record.target === group || group.contains(record.target)) &&
              (record.type !== 'attributes' || record.attributeName === 'aria-valuetext') ||
              [...record.removedNodes, ...record.addedNodes].some((node) => node === oldDistrict || node.contains?.(oldDistrict));
          })) districtUpdated = true;
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        city = await selectFirst('市');
        addedCity = true;
      }
      const refreshed = () => !addedCity || districtUpdated || addressControl('区') !== oldDistrict;
      await waitFor(readyControl('区', city, refreshed), '当前城市区控件更新并稳定', 15000, state);
      let district = selectedAddress('区');
      if (!district || addedCity) { district = await selectFirst('区', city); addedDistrict = true; }
      await waitFor(addressStableCheck(() => {
        guard(city);
        return addressControl('区') && selectedAddress('区') === district ?
          [addressControl('市'), addressControl('区'), city, district] : false;
      }), '本单市区地址稳定', 10000, state);
      state.addressAudit.city = city;
      state.addressAudit.district = district;
      assertAddressPreserved(state);
      if (addedCity || addedDistrict) {
        state.addressNote = `自动补${addedCity && addedDistrict ? '市区' : addedCity ? '市' : '区'}：${defaults[3]}/${city}/${district}；详细地址保持默认`;
      }
      saveState(state);
    } finally { observer?.disconnect(); }
  }

  function validationError(dialog = null) {
    const normalConfirmationNotice = (item) => {
      if (!dialog || item.getAttribute('role') !== 'alert' || !(item === dialog || dialog.contains(item))) return false;
      if (item.matches('.cn-next-message-error, .cn-next-form-item-help, .cn-next-form-item-explain, .form-item .err')) return false;
      // Exempt only the known confirmation phrase and its title/actions, not arbitrary dialog alerts.
      const text = clean(item.innerText);
      return text.includes('是否确定创建销退吗？') &&
        !text.replace(/是否确定创建销退吗？|提示信息|确定|取消|\s/g, '');
    };
    return [...new Set(visibleAll('[role="alert"], .cn-next-message-error, .cn-next-form-item-help, .cn-next-form-item-explain, .form-item .err')
      .filter((item) => !item.closest('#znext-cainiao-panel') && !normalConfirmationNotice(item))
      .map((item) => clean(item.innerText)).filter((value) => value && value !== '*'))].join('；');
  }

  function confirmationDialog() {
    const dialogs = visibleAll('.cn-next-dialog, [role="dialog"]').filter((node) =>
      node.innerText.includes('是否确定创建销退吗？'));
    const innermost = dialogs.filter((node) => !dialogs.some((other) => other !== node && node.contains(other)));
    if (innermost.length > 1) throw new PauseError('创建确认弹窗不唯一，请人工核实');
    return innermost[0];
  }

  function createIdentifiers() {
    const titles = visibleAll('.add-info-title').map((node) => clean(node.innerText));
    const values = (label) => titles.filter((text) => new RegExp('^' + label + '[：:]').test(text))
      .map((text) => clean(text.replace(new RegExp('^' + label + '[：:]'), '')));
    const orders = values('交易单'), lps = values('发货单');
    return orders.length === 1 && lps.length === 1 ? { order: orders[0], lp: lps[0] } : null;
  }

  async function waitForConfirmation(state) {
    await waitFor(() => {
      const dialog = confirmationDialog();
      const error = validationError(dialog);
      if (error) throw new Error(`页面校验提示：${error}`);
      return dialog;
    }, '创建确认弹窗', 5000, state);
  }

  function fill(input, value) {
    if (!input) throw new Error("输入框不存在");
    const descriptor = Object.getOwnPropertyDescriptor(
      input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    );
    descriptor.set.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function unzipXml(buffer, name) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("Excel 文件不是有效的 .xlsx 压缩包");
    let offset = view.getUint32(end + 16, true);
    const count = view.getUint16(end + 10, true);
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Excel 文件目录损坏");
      const method = view.getUint16(offset + 10, true);
      const size = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const entryName = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      offset += 46 + nameLength + extraLength + commentLength;
      if (entryName !== name) continue;
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Excel 文件内容损坏");
      const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) +
        view.getUint16(localOffset + 28, true);
      const compressed = bytes.slice(dataStart, dataStart + size);
      if (method === 0) return new TextDecoder().decode(compressed);
      if (method !== 8) throw new Error("不支持该 Excel 压缩方式");
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    return null;
  }

  function parseXml(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Excel 文件 XML 格式错误");
    return doc;
  }

  function elements(parent, tag) {
    return [...parent.getElementsByTagNameNS("*", tag)];
  }

  function normalizeExportHeaders(table) {
    const alias = 'roms单号', canonical = '销退roms单号';
    if (!table.header.has(alias)) return table;
    if (table.header.has(canonical)) {
      throw new Error(`表格“${table.fileName}”同时包含 ROMS单号 和 销退ROMS单号，销退单号列不唯一，请重新导出仅含一列的原始表`);
    }
    // Rename the header only; retain the original cell index and its formula/precision flags.
    return { ...table, header: new Map([...table.header].map(([name, index]) =>
      [name === alias ? canonical : name, index])) };
  }

  async function readTable(file) {
    if (!file?.name.toLowerCase().endsWith(".xlsx")) throw new Error("请选择 .xlsx 表格");
    if (file.name.startsWith('.~')) throw new Error('选择的是 WPS 临时锁文件，请选择不以 .~ 开头的正式 .xlsx 导出表');
    const buffer = await file.arrayBuffer();
    const workbookXml = await unzipXml(buffer, "xl/workbook.xml");
    const relsXml = await unzipXml(buffer, "xl/_rels/workbook.xml.rels");
    if (!workbookXml || !relsXml) throw new Error("Excel 文件缺少工作表信息");
    const workbook = parseXml(workbookXml);
    const sheets = elements(workbook, "sheet");
    const sheet = sheets.find((item) => item.getAttribute("name") === "售后信息") || sheets[0];
    if (!sheet) throw new Error("Excel 文件没有工作表");
    const relationId = sheet.getAttribute("r:id") ||
      sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const relation = elements(parseXml(relsXml), "Relationship")
      .find((item) => item.getAttribute("Id") === relationId);
    if (!relation) throw new Error("找不到售后工作表");
    const target = relation.getAttribute("Target").replace(/^\//, "");
    const sheetPath = target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}`;
    const sheetXml = await unzipXml(buffer, sheetPath);
    if (!sheetXml) throw new Error("找不到售后工作表内容");
    const sharedXml = await unzipXml(buffer, "xl/sharedStrings.xml");
    const shared = sharedXml ? elements(parseXml(sharedXml), "si").map((item) =>
      elements(item, "t").map((node) => node.textContent).join("")) : [];
    const rows = elements(parseXml(sheetXml), "row").map((row) => {
      const values = [], cellIssues = [];
      for (const cell of elements(row, "c")) {
        const column = /^[A-Z]+/.exec(cell.getAttribute("r") || "")?.[0];
        if (!column) continue;
        let index = 0;
        for (const letter of column) index = index * 26 + letter.charCodeAt(0) - 64;
        const type = cell.getAttribute("t");
        const raw = elements(cell, "v")[0]?.textContent || "";
        const risks = [];
        if (elements(cell, 'f').length) risks.push('单元格含公式，不能作为原始导出值');
        if (type === 'e') risks.push('单元格为错误值');
        if ((!type || type === 'n') && raw && (!/^-?\d+$/.test(raw) || /^-?\d{16,}$/.test(raw) || !Number.isSafeInteger(Number(raw)))) risks.push('数字单元格存在精度或科学计数风险，请从平台重新导出文本编号');
        if (risks.length) cellIssues[index - 1] = risks.join('；');
        values[index - 1] = type === "s" ? shared[Number(raw)] || "" :
          type === "inlineStr" ? elements(cell, "t").map((node) => node.textContent).join("") : raw;
      }
      return { number: Number(row.getAttribute("r") || 0), values, cellIssues };
    });
    const nonempty = rows.filter((row) => row.values.some((value) => clean(value)));
    if (!nonempty.length) throw new Error("表格没有内容");
    const header = new Map();
    nonempty[0].values.forEach((value, index) => {
      const name = clean(value).toLowerCase();
      if (!name) return;
      if (header.has(name)) throw new Error(`表格列名重复：${clean(value)}`);
      header.set(name, index);
    });
    return normalizeExportHeaders({ fileName: file.name, sheetName: sheet.getAttribute('name'), header, rows: nonempty.slice(1) });
  }

  function jobsFromTable(table) {
    const { header, rows } = table;
    const column = (key, required = true) => {
      const aliases = [...new Set(ALIASES[key].map((name) => name.toLowerCase()))].filter((name) => header.has(name));
      if (aliases.length > 1) throw new Error(`同一字段出现多列：${aliases.join('、')}，请使用无歧义原始导出表`);
      const alias = aliases[0];
      if (!alias && required) throw new Error(`缺少必需列：${ALIASES[key][0]}`);
      return alias ? header.get(alias.toLowerCase()) : -1;
    };
    const columns = {
      aftersale: column("aftersale"), order: column("order"),
      waybill: column("waybill"), sku: column("sku"), quantity: column("quantity", false),
      refundType: column('refundType', false), aftersaleStatus: column('aftersaleStatus', false),
      lp: column('lp', false),
    };
    const jobs = new Map();
    const addIssue = (job, issue) => { job.issue = [...new Set([job.issue, issue].filter(Boolean))].join('；'); };
    for (const row of rows) {
      if (!row.values.some((value) => clean(value))) continue;
      const value = (key) => clean(row.values[columns[key]]);
      const aftersale = value("aftersale");
      const order = value("order");
      const waybill = value("waybill");
      const sku = value("sku");
      const key = aftersale || `__invalid_${row.number}`;
      let job = jobs.get(key);
      if (!job) {
        job = { aftersale: aftersale || `表格第${row.number}行`, order, waybill, items: [], issue: "",
          refundType: value('refundType'), aftersaleStatus: value('aftersaleStatus'), lp: value('lp'), sourceBinding: { version: 1, fileName: table.fileName,
            sheetName: table.sheetName, rows: [], snapshot: '' } };
        jobs.set(key, job);
      }
      job.sourceBinding.rows.push(row.number);
      for (const [key, index] of Object.entries(columns)) {
        if (index >= 0 && row.cellIssues?.[index]) addIssue(job, `第 ${row.number} 行${ALIASES[key][0]}：${row.cellIssues[index]}`);
      }
      if (!aftersale || !order || !waybill || !sku) {
        addIssue(job, "缺少售后编号、订单编号、退货运单号或 SKU");
      }
      if (job.order !== order || job.waybill !== waybill) {
        job.bindingConflict = true;
        addIssue(job, "相同售后编号的订单或退货运单不一致");
      }
      if (job.refundType !== value('refundType') || job.aftersaleStatus !== value('aftersaleStatus') || job.lp !== value('lp')) {
        addIssue(job, '相同售后编号的类型、状态或 LP 不一致');
      }
      if (job.lp && !/^LP\d{8,}$/.test(job.lp)) addIssue(job, '原发货 LP 格式不正确');
      if (job.items.some((item) => skuKey(item.sku) === skuKey(sku))) addIssue(job, "相同售后编号的 SKU 重复");
      const quantity = value("quantity");
      if (quantity && !/^[1-9][0-9]*$/.test(quantity)) addIssue(job, `第 ${row.number} 行退货数量不是正整数`);
      job.items.push({ sku, quantity: quantity ? Number(quantity) : null });
      if (quantity && !Number.isSafeInteger(Number(quantity))) addIssue(job, `第 ${row.number} 行退货数量超出安全整数范围`);
    }
    if (!jobs.size) throw new Error("表格没有待处理记录");
    const all = [...jobs.values()];
    for (const job of all) {
      job.sourceBinding.snapshot = bindingSnapshot(job);
      for (const issue of bindingIssues(job, all)) addIssue(job, issue);
    }
    return all;
  }

  async function readJobs(file) {
    return jobsFromTable(await readTable(file));
  }

  const waybillKey = (value) => clean(value).toUpperCase().replace(/\s+/g, '');
  const pairKey = (order, waybill) => JSON.stringify([clean(order), waybillKey(waybill)]);
  const tableValue = (table, row, name) => clean(row.values[table.header.get(name.toLowerCase())]);

  function reportRow(job, status, note = '', lp = job.lp || '', roms = '', reverseLp = '') {
    return [job.aftersale, job.order, lp, job.waybill, status, roms, reverseLp, note, new Date().toLocaleString('zh-CN')];
  }

  function matchTables(tables, confirmedResults = []) {
    const kinds = groupTables(tables);
    const pdd = kinds.get('pdd'), orders = kinds.get('orders'), returns = kinds.get('returns');
    const sourceJobs = jobsFromTable(pdd);
    const existing = new Map(), canceled = new Set(), orderMap = new Map();
    const duplicateReturns = new Set(), romsBindings = new Map(), lpOrders = new Map();
    for (const row of returns.rows) {
      const order = tableValue(returns, row, '交易单号');
      const waybill = tableValue(returns, row, '运单号');
      if (!order || !waybill) continue;
      for (const name of ['交易单号', '运单号', '销退ROMS单号', '正向LP单号']) {
        if (row.cellIssues?.[returns.header.get(name.toLowerCase())]) throw new Error(`销退表第 ${row.number} 行${name}存在公式、错误值或数字精度风险`);
      }
      const key = pairKey(order, waybill);
      const roms = tableValue(returns, row, '销退ROMS单号');
      const lp = tableValue(returns, row, '正向LP单号');
      const signature = JSON.stringify([order, waybillKey(waybill), lp, tableValue(returns, row, '状态')]);
      if (!/^ROMS\d+$/.test(roms)) throw new Error(`销退表第 ${row.number} 行系统单号无效`);
      if (romsBindings.has(roms) && romsBindings.get(roms) !== signature) throw new Error('同一 ROMS 对应不同订单、运单、LP 或状态，请重新导出核实');
      romsBindings.set(roms, signature);
      if (tableValue(returns, row, '状态') === '销退已取消') canceled.add(key);
      else {
        if (!tableValue(returns, row, '销退ROMS单号') || !tableValue(returns, row, '状态')) {
          throw new Error(`销退表第 ${row.number} 行缺少销退单号或状态，请重新导出`);
        }
        if (!/^LP\d{8,}$/.test(lp)) throw new Error(`销退表第 ${row.number} 行原发货 LP 无效`);
        if (existing.has(key) && existing.get(key).roms !== roms) duplicateReturns.add(key);
        existing.set(key, {
          order, waybill, status: tableValue(returns, row, '状态'),
          lp: tableValue(returns, row, '正向LP单号'), roms: tableValue(returns, row, '销退ROMS单号'),
          reverseLp: tableValue(returns, row, '逆向LP单号'),
        });
      }
    }
    for (const row of orders.rows) {
      const order = tableValue(orders, row, '交易单号');
      if (!order) continue;
      if (!orderMap.has(order)) orderMap.set(order, []);
      const lp = tableValue(orders, row, '物流单号');
      if (lp) { if (!lpOrders.has(lp)) lpOrders.set(lp, new Set()); lpOrders.get(lp).add(order); }
      for (const name of ['交易单号', '物流单号', '货品ID', '系统单号']) {
        if (row.cellIssues?.[orders.header.get(name.toLowerCase())]) throw new Error(`原订单表第 ${row.number} 行${name}存在公式、错误值或数字精度风险`);
      }
      orderMap.get(order).push({ lp, system: tableValue(orders, row, '系统单号'),
        channel: tableValue(orders, row, '销售渠道'), status: tableValue(orders, row, '订单状态'),
        goodsId: tableValue(orders, row, '货品ID'), goodsQuantity: Number(tableValue(orders, row, '货品数量')) });
    }
    const confirmed = new Map();
    for (const row of confirmedResults) {
      if (row[4] !== '已创建' || !row[1] || !row[3] || !/^ROMS\d+$/.test(row[5])) continue;
      const key = pairKey(row[1], row[3]);
      if (confirmed.has(key) && confirmed.get(key)[5] !== row[5] || existing.has(key) && existing.get(key).roms !== row[5] && !canceled.has(key)) duplicateReturns.add(key);
      confirmed.set(key, row);
      if (!existing.has(key) && !canceled.has(key)) existing.set(key, {
        order: row[1], waybill: row[3], status: '本标签页已确认创建',
        lp: row[2], roms: row[5], reverseLp: row[6],
        note: '已在本标签页的处理记录中确认创建，跳过导出后创建的记录',
      });
    }
    const returnsByOrder = new Map();
    for (const entry of existing.values()) {
      if (!returnsByOrder.has(entry.order)) returnsByOrder.set(entry.order, []);
      returnsByOrder.get(entry.order).push(entry);
    }
    const jobs = [], results = [], seenPairs = new Map();
    const summary = { total: sourceJobs.length, ready: 0, existing: 0, excluded: 0, issues: 0, waybillIssues: 0 };
    for (const job of sourceJobs) {
      const key = pairKey(job.order, job.waybill);
      if (!seenPairs.has(key)) seenPairs.set(key, []);
      seenPairs.get(key).push(job);
    }
    for (const job of sourceJobs) {
      if (job.bindingConflict) {
        results.push(reportRow(job, '需核实', job.issue || '源售后订单与退货运单配对冲突'));
        summary.issues++;
        continue;
      }
      if (job.refundType !== '退货退款' || job.aftersaleStatus !== '待商家处理') {
        results.push(reportRow(job, '无需建单', `售后状态：${job.aftersaleStatus || '空'}；退款类型：${job.refundType || '空'}`));
        summary.excluded++;
        continue;
      }
      const key = pairKey(job.order, job.waybill);
      const found = existing.get(key);
      let issue = job.issue;
      if (!issue && seenPairs.get(key).length > 1) issue = '不同售后编号使用同一订单和退货运单，请人工核对';
      if (!issue && duplicateReturns.has(key)) issue = '同一订单和退货运单有多个有效销退，请人工核对';
      const conflicts = (returnsByOrder.get(job.order) || []).filter((entry) =>
        waybillKey(entry.waybill) !== waybillKey(job.waybill));
      if (!issue && conflicts.length) {
        const old = conflicts.map((entry) => `${entry.roms}（${entry.status}；旧运单 ${entry.waybill}；原LP ${entry.lp || '空'}）`).join('；');
        const note = `同订单有不同退货运单的有效销退：${old}。新运单 ${job.waybill}。疑似买家更换运单；请核实旧运单未寄出且旧单可取消，取消旧销退后下载最新销退表再重建。多个旧单或已进入收货流程请人工核实。`;
        results.push(reportRow(job, '疑似换运单，需处理', note,
          conflicts.length === 1 ? conflicts[0].lp : '', conflicts.length === 1 ? conflicts[0].roms : '',
          conflicts.length === 1 ? conflicts[0].reverseLp : ''));
        summary.issues++;
        summary.waybillIssues++;
        continue;
      }
      if (!issue && !found && canceled.has(key)) issue = '对应销退已取消，请人工确认是否需要重建';
      if (!issue && found) {
        results.push(reportRow(job, '已建跳过', found.note || '销退表已有相同订单号和退货运单号的未取消记录，已跳过', found.lp, found.roms, found.reverseLp));
        summary.existing++;
        continue;
      }
      const allMatches = orderMap.get(job.order) || [];
      const matches = allMatches.filter((row) => row.channel === '拼多多' && row.status === '已出库');
      const lps = [...new Set(matches.map((row) => row.lp).filter(Boolean))];
      let pendingLookup = false;
      if (!issue && allMatches.length && matches.length !== allMatches.length) issue = '订单销售渠道或状态不符合拼多多已出库，需人工核对';
      const systems = [...new Set(matches.map((row) => row.system).filter(Boolean))];
      if (!issue && (systems.length > 1 || systems.some((system) => !/^GPL\d+$/.test(system)))) issue = '原订单关联多个系统单或系统单格式无效，请人工核对';
      if (!issue && lps.some((lp) => lpOrders.get(lp)?.size > 1)) issue = '同一原发货 LP 关联不同原订单，请人工核对';
      if (!issue && job.lp && lps.length === 1 && job.lp !== lps[0]) issue = '售后表原发货 LP 与原订单导出不一致，请人工核对';
      if (!issue && lps.length > 1) issue = '同一订单关联多个原发货 LP，请人工核对';
      if (!issue && lps.some((lp) => !/^LP\d{8,}$/.test(lp))) issue = '原发货 LP 格式不正确';
      if (!issue && !allMatches.length) pendingLookup = true;
      if (!issue && allMatches.length && (!lps.length || matches.some((row) => !row.lp))) issue = '导出原订单存在但原发货LP缺失，请人工核对';
      if (issue) {
        results.push(reportRow(job, '需核实', issue));
        summary.issues++;
      } else {
        const goodsIds = [...new Set(matches.map((row) => row.goodsId))];
        // One product in the original order and one refund item establish the
        // mapping even when PDD and Cainiao use different model/size labels.
        const singleGoodsId = job.items.length === 1 && goodsIds.length === 1 && /^\d+$/.test(goodsIds[0])
          ? goodsIds[0] : '';
        const readyJob = { ...job, lp: pendingLookup ? '' : lps[0], pendingLookup, items: job.items.map((item) =>
          singleGoodsId ? { ...item, goodsId: singleGoodsId } : { ...item }) };
        readyJob.mappingBinding = mappingSnapshot(readyJob);
        jobs.push(readyJob);
        summary.ready++;
        if (pendingLookup) summary.lookup = (summary.lookup || 0) + 1;
      }
    }
    return { jobs, results, summary, fileName: pdd.fileName,
      sourceFiles: tables.map((table) => table.fileName), mode: 'three', confirmedResults: [...confirmed.values()] };
  }

  async function readThreeFiles(files) {
    // Sequential reads keep memory bounded for large exports.
    if (files.length < 3) throw new Error('请一次选择三类 .xlsx 原始导出表；分批导出的同类文件可多选');
    const previous = loadState();
    const confirmed = [...(previous?.confirmedResults || []), ...(previous?.results || [])];
    const tables = [];
    for (const file of files) tables.push(await readTable(file));
    return matchTables(tables, confirmed);
  }

  // Export preparation uses the same visible controls as manual operation.
  const ORDER_BATCH_SIZE = 100;
  const RETURN_HEADERS = ['销退ROMS单号', '正向LP单号', '运单号', '交易单号', '状态', '逆向LP单号', '销退创建时间'];
  const TABLE_TYPES = [
    { kind: 'pdd', label: '拼多多售后表', headers: ['售后编号', '订单编号', '退货运单号', 'sku信息', '退款类型', '售后状态'] },
    { kind: 'orders', label: '全渠道订单表', headers: ['交易单号', '物流单号', '销售渠道', '订单状态'] },
    { kind: 'returns', label: '销退表', headers: RETURN_HEADERS.slice(0, 6) },
  ];
  const tableKind = (table) => {
    const normalized = normalizeExportHeaders(table);
    return TABLE_TYPES.find((type) => type.headers.every((name) => normalized.header.has(name.toLowerCase())))?.kind || '';
  };
  const tableLabel = (kind) => TABLE_TYPES.find((type) => type.kind === kind)?.label || '未识别类型';
  function tableHeaderError(table) {
    table = normalizeExportHeaders(table);
    const marked = {
      pdd: table.header.has('售后编号'),
      orders: table.header.has('系统单号') || table.header.has('物流单号'),
      returns: table.header.has('销退roms单号'),
    };
    // Marker columns guide the error message only; tableKind still requires every core header.
    const checks = TABLE_TYPES.filter((type) => marked[type.kind]).map((type) =>
      `${type.label}缺少必需列：${type.headers.filter((name) => !table.header.has(name.toLowerCase())).join('、')}`);
    if (checks.length) return `无法识别表格“${table.fileName}”：${checks.join('；')}。请使用字段完整的原始导出表`;
    const names = [...table.header.keys()];
    const detected = names.slice(0, 8).join('、') + (names.length > 8 ? `等 ${names.length} 列` : '');
    return `无法识别表格“${table.fileName}”（检测类型：未识别类型）。支持拼多多售后、全渠道订单和销退三类原始导出表；实际表头：${detected || '空'}`;
  }

  function mergeTables(tables) {
    const header = tables[0].header;
    const names = [...header.keys()];
    const seen = new Set(), rows = [];
    for (const table of tables) {
      if (table.header.size !== header.size || names.some((name) => !table.header.has(name))) {
        throw new Error('同类导出文件的列不一致，请重新下载');
      }
      for (const row of table.rows) {
        const values = [], cellIssues = [];
        for (const name of names) {
          values[header.get(name)] = row.values[table.header.get(name)] ?? '';
          cellIssues[header.get(name)] = row.cellIssues?.[table.header.get(name)] || '';
        }
        const key = JSON.stringify([values, cellIssues]);
        if (!seen.has(key)) { seen.add(key); rows.push({ number: row.number, values, cellIssues }); }
      }
    }
    return { fileName: tables.map((t) => t.fileName).join('、'), sheetName: tables[0].sheetName, header, rows };
  }

  function groupTables(tables) {
    const groups = new Map();
    for (const original of tables) {
      const table = normalizeExportHeaders(original);
      const kind = tableKind(table);
      if (!kind) throw new Error(tableHeaderError(table));
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(table);
    }
    if (groups.get('pdd')?.length !== 1) throw new Error('请只选择一张拼多多售后表');
    if (!groups.has('orders') || !groups.has('returns')) throw new Error(`已识别：${[...groups.keys()].map(tableLabel).join('、')}；缺少：${['orders', 'returns'].filter((kind) => !groups.has(kind)).map(tableLabel).join('、')}，请补选原始导出表`);
    return new Map([...groups].map(([kind, list]) => [kind, kind === 'pdd' ? list[0] : mergeTables(list)]));
  }

  const packTable = (table) => ({ ...table, header: [...table.header] });
  const unpackTable = (table) => normalizeExportHeaders({ ...table, header: new Map(table.header) });
  function minimalPdd(table) {
    const keep = new Set(Object.values(ALIASES).flat().map((name) => name.toLowerCase()));
    const entries = [...table.header].filter(([name]) => keep.has(name));
    return { fileName: table.fileName, sheetName: table.sheetName,
      header: new Map(entries.map(([name], index) => [name, index])),
      rows: table.rows.map((row) => ({ number: row.number, values: entries.map(([, index]) => row.values[index] ?? ''),
        cellIssues: entries.map(([, index]) => row.cellIssues?.[index] || '') })) };
  }

  function preparePlan(table) {
    if (tableKind(table) !== 'pdd') throw new Error(`读取到${tableLabel(tableKind(table))}，请选择拼多多待商家处理的原始售后表${tableKind(table) ? '' : `；${tableHeaderError(table)}`}`);
    const pdd = minimalPdd(table);
    const source = jobsFromTable(pdd);
    const ids = [...new Set(source.filter((job) => !job.issue && job.refundType === '退货退款' &&
      job.aftersaleStatus === '待商家处理').map((job) => job.order))];
    if (!ids.length) throw new Error('没有带退货运单且字段完整的待商家处理退货退款，请检查原表');
    const previous = loadState();
    return { id: crypto.randomUUID(), flow: 'prepare', mode: 'prepare', fileName: table.fileName,
      jobs: [], results: [], index: 0, active: false, stage: 'prep_ready',
      pdd: packTable(pdd), startedAt: 0, orderIds: ids,
      groups: Array.from({ length: Math.ceil(ids.length / ORDER_BATCH_SIZE) }, (_, i) => ids.slice(i * ORDER_BATCH_SIZE, (i + 1) * ORDER_BATCH_SIZE)),
      groupIndex: 0, observedOrders: [], missingOrders: [], returnQueue: [], returnScopes: [], exports: [],
      confirmedResults: [...(previous?.confirmedResults || []), ...(previous?.results || [])].filter((row) => row[4] === '已创建'),
      prepMessage: `售后 ${source.length} 单；需查询 ${ids.length} 个原订单。准备过程只查询和导出。` };
  }

  function dayValue(value) {
    const text = clean(value);
    if (/^\d+(\.\d+)?$/.test(text)) {
      const number = Number(text);
      if (number > 30000 && number < 100000) return new Date(Date.UTC(1899, 11, 30) + number * 86400000).toISOString().slice(0, 10);
    }
    const match = /^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
    if (!match) throw new Error(`无法识别创建日期：${text || '空'}`);
    const day = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error('创建日期无效');
    return day;
  }
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  function splitDays(scope) {
    const start = Date.parse(`${scope.start}T00:00:00Z`), end = Date.parse(`${scope.end}T00:00:00Z`);
    if (end <= start) throw new PauseError('同一天销退超过一万条，无法继续按日期拆分，请人工按其他条件导出');
    const middle = start + Math.floor((end - start) / 86400000 / 2) * 86400000;
    return [{ start: scope.start, end: new Date(middle).toISOString().slice(0, 10) },
      { start: new Date(middle + 86400000).toISOString().slice(0, 10), end: scope.end }];
  }

  function prepNote(state, text) { state.prepMessage = text; saveState(state); }
  function pageButton(text) { return visibleAll('button').find((el) => clean(el.innerText).replace(/[\ue000-\uf8ff]/g, '').trim() === text); }
  function selectedTab(text) { return visibleAll('[role="tab"]').find((el) => clean(el.innerText).startsWith(text) && el.getAttribute('aria-selected') === 'true'); }
  function isDisabled(el) { return !el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled'); }
  function tableLoading() {
    return visibleAll('.cn-next-loading-tip, .cn-next-loading-indicator, [aria-busy="true"]').some((el) => !el.closest('#znext-cainiao-panel')) ||
      visibleAll('div,span').some((el) => !el.children.length && ['加载中...', '加载中'].includes(clean(el.innerText)));
  }
  function pageErrors() {
    return visibleAll('[role="alert"], .cn-next-message-error, .cn-next-form-item-help, .cn-next-form-item-explain')
      .filter((el) => !el.closest('#znext-cainiao-panel'))
      .filter((el) => el.matches('.cn-next-message-error, .cn-next-form-item-help, .cn-next-form-item-explain') ||
        /失败|错误|异常|请检查|不能|超过|上限|未能|不允许|无权限|error|failed/i.test(clean(el.innerText)))
      .map((element) => ({ element, text: clean(element.innerText) })).filter((entry) => entry.text);
  }
  function prepPageError() {
    const error = pageErrors().map((entry) => entry.text).join('；');
    if (error) throw new PauseError(`后台提示：${error}`);
  }
  function resultCount() {
    const text = clean(document.querySelector('[role="tabpanel"]')?.innerText || document.body.innerText);
    const count = /选中\s*\d+\s*项\s*\/\s*共\s*(\d+)\s*项/.exec(text);
    if (!count) return null;
    return Number(count[1]);
  }
  async function tableSettled(state) {
    let last = '', since = 0;
    await waitFor(() => {
      prepPageError();
      if (tableLoading() || resultCount() === null) { since = 0; return false; }
      const value = JSON.stringify([resultCount(), visibleAll('tr.cn-table-row').map((row) => clean(row.innerText))]);
      if (value !== last || !since) { last = value; since = Date.now(); return false; }
      return Date.now() - since >= 750;
    }, '查询完成', 30000, state);
  }

  async function prepClick(state, element, label) {
    if (isDisabled(element)) throw new Error(`${label}不可操作`);
    await pace(state); assertActive(state); element.click();
  }
  async function closeTasks(state) {
    const close = visibleAll('.cn-ui-async-jobs-pro-container-close')[0];
    if (close) { await prepClick(state, close, '关闭任务面板'); await waitFor(() => !visibleAll('.cn-ui-async-jobs-pro-container').length, '关闭任务面板', 5000, state); }
  }
  async function resetFilter(state, tabName) {
    await closeTasks(state);
    const tab = await waitFor(() => visibleAll('[role="tab"]').find((el) => clean(el.innerText).startsWith(tabName)), tabName, 20000, state);
    if (!selectedTab(tabName)) { await prepClick(state, tab, tabName); await tableSettled(state); }
    await prepClick(state, pageButton('重置'), '重置筛选');
    await tableSettled(state);
    if (!selectedTab(tabName)) throw new Error('重置后没有保持全部状态');
  }

  function orderInput() { return visibleAll('input').find((el) => queryVisible(el) && clean(el.placeholder).includes('交易单号/系统单号')); }
  function orderRows() {
    return identityListRows().filter((row) => /交易\s*[:：]/.test(clean(row.innerText))).map((row) => {
      const text = clean(row.innerText);
      const order = /交易\s*[:：]\s*([^\s]+)/.exec(text)?.[1];
      const system = /系统\s*[:：]\s*(GPL\d+)/.exec(text)?.[1];
      const created = /系统创建\s*[:：]\s*(20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/.exec(text)?.[1];
      if (!order || !system || !created) throw new Error('订单行缺少交易单号、系统单号或系统创建时间，已停止导出');
      return { order, system, created, lps: [...new Set(text.match(/LP\d{8,}/g) || [])],
        goodsIds: [...new Set([...text.matchAll(/\b(\d{8,})\s*\*\s*\d+/g)].map((match) => match[1]))],
        goods: [...text.matchAll(/\b(\d{8,})\s*\*\s*(\d+)/g)].map((match) => ({ id: match[1], quantity: Number(match[2]) })),
        isPdd: text.includes('拼多多'), isOutbound: /(?:^|\s)已出库(?:\s|$)/.test(text) }; 
    });
  }
  function checkOrderScope(scope, includeRows = true) {
    if (!selectedTab('全部订单') || clean(orderInput()?.value).split(/[,\n]/).filter(Boolean).sort().join(',') !== [...scope.ids].sort().join(',')) {
      throw new PauseError('订单查询条件与本批清单不一致，未导出');
    }
    if (!orderFormReady()) throw new PauseError('订单查询残留筛选或控件不稳定，未导出');
    const rows = includeRows ? orderRows() : [];
    if (rows.some((row) => !scope.ids.includes(row.order))) throw new PauseError('查询返回了清单以外的订单，未导出');
    return rows;
  }

  function filterValue(control) {
    const value = clean(control.getAttribute('aria-valuetext') || control.value ||
      control.closest('.cn-next-form-item')?.querySelector('em')?.innerText);
    return /^请选择/.test(value) ? '' : value;
  }
  function orderDefault(control) {
    const value = filterValue(control);
    const field = control.closest('.cn-next-form-item')?.querySelector('label')?.htmlFor;
    if (!value) return true;
    if (value === '包含全部') return !control.id && control.readOnly && ['scItemId', 'scItemCode', 'itemId'].includes(field);
    if (value === '保税中心仓') return control.id === 'storeType';
    return value === '全部' && ['orderSource', 'shopName', 'storeCode', 'businessUnitId', 'existSaleAfter', 'orderStatus', 'logisticsStatus', 'deliveryType', 'orderFlagList', 'channelCode'].includes(control.id);
  }
  function queryButton(text) { return visibleAll('button').filter(queryVisible).find((el) => clean(el.innerText).replace(/[\ue000-\uf8ff]/g, '').trim() === text); }
  function orderFormReady(empty = false, allowResidual = false) {
    const inputs = visibleAll('input').filter((el) => queryVisible(el) && clean(el.placeholder).includes('交易单号/系统单号'));
    if (!selectedTab('全部订单') || inputs.length !== 1 || isDisabled(inputs[0])) return null;
    const input = inputs[0], form = input.closest('form, .cn-next-form');
    const reset = queryButton('重置'), query = queryButton('查询');
    if (!form || !input.isConnected || isDisabled(reset) || isDisabled(query)) return null;
    const others = [...form.querySelectorAll('input')].filter((el) => el !== input);
    if (!allowResidual && others.some((el) => clean(el.value) && !(el.matches('[role="combobox"]') && orderDefault(el)))) return null;
    const controls = [...form.querySelectorAll('[role="combobox"]')];
    if (!allowResidual && controls.some((control) => !orderDefault(control))) return null;
    if (empty && clean(input.value)) return null;
    return [input, form, reset, query, clean(input.value), ...others.map((el) => el.value), ...controls.map(filterValue)];
  }
  async function prepareOrderFilter(state) {
    await closeTasks(state);
    const tab = await waitFor(() => visibleAll('[role="tab"]').find((el) => clean(el.innerText).startsWith('全部订单')), '全部订单标签', 20000, state);
    if (!selectedTab('全部订单')) await prepClick(state, tab, '全部订单');
    // Only the current form matters here; switching/resetting can launch slow unfiltered requests.
    await waitFor(addressStableCheck(() => orderFormReady(false, true)), '全部订单查询表单稳定', 15000, state);
    if (orderFormReady(true)) return;
    await pace(state); assertActive(state);
    const reset = queryButton('重置');
    if (isDisabled(reset)) throw new PauseError('订单重置控件尚不可用');
    reset.click();
    await waitFor(addressStableCheck(() => orderFormReady(true)), '订单筛选清空及控件稳定', 15000, state);
  }
  function queryVisible(el) {
    const box = el?.getBoundingClientRect();
    return !!el && shown(el) && box.width > 0 && box.height > 0 &&
      !el.closest('[aria-hidden="true"], [role="tabpanel"].hidden');
  }
  function listingRoots() {
    const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(queryVisible);
    const tables = [...document.querySelectorAll('.cn-table')].filter(queryVisible)
      .filter((el) => !panels.some((panel) => panel.contains(el)));
    const roots = [...panels, ...tables];
    return (roots.length ? roots : [...document.querySelectorAll('table')].filter(queryVisible))
      .filter((el) => !el.closest('#znext-cainiao-panel, .cn-next-drawer'));
  }
  function identityListRows() {
    return [...new Set(listingRoots().flatMap((root) => [...root.querySelectorAll('tr.cn-table-row')]))].filter(queryVisible);
  }
  function identityCount() {
    const panels = [...document.querySelectorAll('[role="tabpanel"]')].filter(queryVisible);
    const texts = panels.length ? panels.map((panel) => clean(panel.innerText)) : [clean(document.body.innerText)];
    const counts = texts.flatMap((text) => [...text.matchAll(/选中\s*\d+\s*项\s*\/\s*共\s*(\d+)\s*项/g)].map((match) => Number(match[1])));
    return counts.length === 1 ? counts[0] : null;
  }
  function listingLoading() {
    return listingRoots().some((root) => root.matches('[aria-busy="true"]') ||
      [...root.querySelectorAll('.cn-next-loading-tip, .cn-next-loading-indicator, [aria-busy="true"]')].some(shown) ||
      [...root.querySelectorAll('div,span')].some((el) => shown(el) && !el.children.length && ['加载中...', '加载中'].includes(clean(el.innerText))));
  }
  function queryFence() {
    const oldErrors = new Map(pageErrors().map((entry) => [entry.element, entry.text]));
    const changedErrors = new Set();
    const fence = { changed: false };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target.closest?.('#znext-cainiao-panel') || record.target.parentElement?.closest('#znext-cainiao-panel')) continue;
        const roots = listingRoots();
        const nodes = [...record.addedNodes, ...record.removedNodes];
        const resultArea = (node) => {
          const el = node.nodeType === 1 ? node : node.parentElement;
          if (!el || el.closest('form, .cn-next-form, #znext-cainiao-panel, .cn-next-drawer')) return false;
          if (node.nodeType === 3 && /选中\s*\d+\s*项\s*\/\s*共\s*\d+\s*项/.test(clean(node.textContent))) return true;
          if (el.closest('.cn-table, table, .cn-next-pagination, .cn-next-loading-tip, .cn-next-loading-indicator, [aria-busy="true"]')) return true;
          return /选中\s*\d+\s*项\s*\/\s*共\s*\d+\s*项/.test(clean(el.innerText)) && !el.matches('[role="tabpanel"], body');
        };
        const replacement = nodes.some((node) => node.nodeType === 1 && (node.matches('[role="tabpanel"], .cn-table, table') ||
          !node.matches('form, .cn-next-form') && node.querySelector('table, .cn-table, .cn-next-loading-indicator, .cn-next-loading-tip')));
        if (roots.some((root) => root === record.target || root.contains(record.target) || nodes.some((node) => node === root || node.contains?.(root))) &&
            (resultArea(record.target) || nodes.some(resultArea) || replacement || record.type === 'attributes' && record.attributeName === 'aria-busy' && record.oldValue === 'true' && !record.target.closest('form, .cn-next-form'))) fence.changed = true;
        for (const element of oldErrors.keys()) {
          if (record.type !== 'attributes' && (element === record.target || element.contains(record.target) || nodes.some((node) => node === element || node.contains?.(element)))) changedErrors.add(element);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-busy', 'class'], attributeOldValue: true });
    fence.checkError = () => {
      const errors = pageErrors().filter((entry) => changedErrors.has(entry.element) || oldErrors.get(entry.element) !== entry.text);
      if (errors.length) throw new PauseError(`精确查询后台提示：${errors.map((entry) => entry.text).join('；')}`);
    };
    fence.close = () => observer.disconnect();
    return fence;
  }
  async function querySnapshot(state, read, label, fence = null, timeout = 20000) {
    let last = '', since = 0, sample = { responseObserved: false };
    try {
      return await waitFor(() => {
        fence?.checkError();
        const observed = !fence || fence.changed;
        const loading = listingLoading();
        sample = { responseObserved: observed, loading, count: identityCount() };
        if (!observed || loading) { since = 0; return false; }
        const result = read(sample);
        if (!result) { since = 0; return false; }
        const signature = JSON.stringify(result);
        if (last !== signature || !since) { last = signature; since = Date.now(); return false; }
        return Date.now() - since >= 750 ? result : false;
      }, label, timeout, state);
    } catch (error) {
      if (/超时/.test(message(error))) {
        state.queryDiagnostics = { label, sample, time: new Date().toISOString(), batchId: state.id, jobIndex: state.index };
        saveState(state);
        throw new PauseError(`${label}尚未确认完整返回，已暂停；可稍后从当前进度继续`);
      }
      throw error;
    }
  }
  async function queryOrders(state, ids) {
    await prepareOrderFilter(state);
    await pace(state); assertActive(state);
    const ready = orderFormReady(true);
    if (!ready) throw new PauseError('订单筛选控件或空条件发生变化，未查询');
    ready[0].click();
    const area = await waitFor(() => visibleAll('textarea[data-real="true"]').filter(queryVisible)[0], '批量添加订单号', 8000, state);
    fill(area, ids.join('\n')); area.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    await pace(state); assertActive(state);
    const outside = visibleAll('nav[aria-label="Breadcrumb"]')[0] || visibleAll('[role="navigation"]')[0];
    if (!outside) throw new Error('未找到离开批量输入浮层的页面位置');
    outside.click();
    await waitFor(() => !shown(area), '关闭批量输入浮层', 5000, state);
    const scope = { kind: 'orders', ids };
    await waitFor(addressStableCheck(() => {
      const current = orderFormReady();
      return current && clean(current[0].value).split(/[,\n]/).filter(Boolean).sort().join(',') === [...ids].sort().join(',') ? current : false;
    }), '目标订单输入及控件稳定', 10000, state);
    await pace(state); assertActive(state); checkOrderScope(scope, false);
    const query = queryButton('查询');
    if (isDisabled(query)) throw new PauseError('精确订单查询按钮不可用');
    const fence = queryFence();
    try {
      query.click();
      const observed = [], seen = new Set();
      let count = null, previousPage = '';
      for (let page = 0; page < 1000; page++) {
        const snapshot = await querySnapshot(state, (sample) => {
          checkOrderScope(scope, false);
          let rows;
          try { rows = orderRows(); } catch (error) { sample.partialRows = message(error); return false; }
          sample.rows = rows.length; sample.orders = rows.map((row) => row.order);
          const next = visibleAll('button[aria-label^="下一页"]').filter(queryVisible)[0], lastPage = isDisabled(next);
          if (rows.some((row) => !ids.includes(row.order)) || sample.count === null ||
              count !== null && sample.count !== count || lastPage && observed.length + rows.length !== sample.count) return false;
          return { count: sample.count, rows, lastPage };
        }, '精确订单查询结果', fence);
        count ??= snapshot.count;
        const signature = JSON.stringify(snapshot.rows);
        if (page && signature === previousPage) throw new PauseError('订单翻页没有变化，未导出');
        previousPage = signature;
        for (const row of snapshot.rows) {
          if (seen.has(row.system)) throw new PauseError('订单翻页出现重复系统单号，未导出');
          seen.add(row.system); observed.push(row);
        }
        if (snapshot.lastPage) return { ...scope, count, observed };
        await pace(state); assertActive(state); checkOrderScope(scope, false);
        fence.changed = false;
        const next = visibleAll('button[aria-label^="下一页"]').filter(queryVisible)[0];
        if (isDisabled(next)) throw new PauseError('订单分页控件发生变化');
        next.click();
      }
      throw new PauseError('订单分页超出上限，未导出');
    } finally { fence.close(); }
  }

  function returnRows(rows = visibleAll('tr.cn-table-row')) {
    return rows.filter((row) => /ROMS\d+/.test(row.innerText)).map((row) => {
      const cells = [...row.querySelectorAll('td')].map((cell) => clean(cell.innerText));
      const text = clean(row.innerText), roms = /ROMS\d+/.exec(text)?.[0];
      const created = /20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.exec(text)?.[0];
      if (!roms || !created || cells.length < 9) throw new Error('销退列表字段无法识别，未导出');
      return { roms, lp: cells[6], waybill: cells[4], status: cells[3], created };
    });
  }
  function returnDateInputs() {
    const group = document.getElementById('orderCreateDate');
    return group ? [...group.querySelectorAll('input')] : [];
  }
  function appliedReturnDates(scope) {
    return visibleAll('[role="button"],button').some((el) => {
      const text = clean(el.innerText);
      return text.includes('销退单创建时间:') && text.includes(`${scope.start} ~ ${scope.end}`);
    });
  }
  function checkReturnScope(scope) {
    const inputs = returnDateInputs();
    if (!selectedTab('全部(') || inputs.length !== 2 || inputs[0].value !== scope.start || inputs[1].value !== scope.end || !appliedReturnDates(scope)) {
      throw new Error('销退日期筛选尚未生效或未选全部状态，未导出');
    }
    const rows = returnRows();
    if (rows.some((row) => dayValue(row.created) < scope.start || dayValue(row.created) > scope.end)) throw new Error('销退查询结果超出日期范围，未导出');
    const form = inputs[0].closest('form');
    if (form && [...form.querySelectorAll('input')].some((el) => !inputs.includes(el) &&
      !el.matches('#storeType') && clean(el.value))) throw new Error('销退残留其他筛选条件，未导出');
    return rows;
  }
  async function queryReturns(state, dates) {
    await resetFilter(state, '全部(');
    const inputs = returnDateInputs();
    if (inputs.length !== 2) throw new Error('未找到销退创建时间的起止输入框');
    for (const [i, value] of [dates.start, dates.end].entries()) {
      await pace(state); assertActive(state);
      const input = returnDateInputs()[i];
      input.focus(); fill(input, value);
      // Let the controlled picker accept input before committing with Enter.
      await sleep(0); assertActive(state);
      const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      input.dispatchEvent(new KeyboardEvent('keydown', enter));
      input.dispatchEvent(new KeyboardEvent('keyup', enter));
      await sleep(0); assertActive(state);
      input.blur();
    }
    const outside = visibleAll('nav[aria-label="Breadcrumb"]')[0];
    if (outside) await prepClick(state, outside, '完成日期输入');
    await prepClick(state, pageButton('查询'), '查询全部状态销退');
    await tableSettled(state);
    if (!appliedReturnDates(dates)) {
      // Date picker may consume the first click to commit editing.
      await prepClick(state, pageButton('查询'), '提交已填写日期');
      await tableSettled(state);
    }
    return { ...dates, kind: 'returns', count: resultCount(), samples: checkReturnScope(dates) };
  }

  function exportTasks() {
    return visibleAll('.cn-ui-async-jobs-pro-item').map((item) => ({
      title: clean(item.querySelector('.cn-ui-async-jobs-pro-item-content-title')?.textContent),
      status: clean(item.querySelector('.cn-ui-async-jobs-pro-item-content-status')?.textContent), item,
    }));
  }
  async function openTasks(state) {
    if (!visibleAll('.cn-ui-async-jobs-pro-container').length) {
      await prepClick(state, await waitFor(() => visibleAll('.cn-ui-async-jobs-pro-trigger')[0], '导出任务入口', 10000, state), '导出任务');
    }
    // Empty placeholders can precede asynchronously loaded old tasks. Require stability.
    let emptySince = 0;
    await waitFor(() => {
      const container = visibleAll('.cn-ui-async-jobs-pro-container')[0];
      if (!container) { emptySince = 0; return false; }
      if (exportTasks().length) return true;
      if (!/暂无|无数据|没有/.test(clean(container.innerText)) || /加载|loading/i.test(clean(container.innerText))) {
        emptySince = 0; return false;
      }
      emptySince ||= Date.now();
      return Date.now() - emptySince >= 3000;
    }, '导出任务列表加载稳定', 15000, state);
  }
  const taskPrefix = (kind) => kind === 'orders' ? '订单导出任务' : '全渠道销退单导出任务';
  function newTask(intent, tasks) {
    if (intent.title) {
      const matches = tasks.filter((task) => task.title === intent.title);
      if (matches.length !== 1) return null;
      return matches[0];
    }
    const candidates = tasks.filter((task) => {
      if (!task.title.startsWith(taskPrefix(intent.kind)) || intent.baseline.includes(task.title)) return false;
      const timestamp = /20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.exec(task.title)?.[0];
      return timestamp && Date.parse(timestamp.replace(' ', 'T') + '+08:00') >= intent.submittedAt - 1000;
    });
    if (candidates.length > 1) throw new PauseError('同时出现多个同类型新导出任务，无法确定本批文件，请人工核实；不要重复提交');
    return candidates[0] || null;
  }

  async function beginExport(state, scope) {
    await openTasks(state);
    const baseline = exportTasks().map((task) => task.title);
    await closeTasks(state);
    if (scope.kind === 'orders') checkOrderScope(scope); else checkReturnScope(scope);
    if (resultCount() !== scope.count) throw new Error('导出前后台总数变化，请重新查询');
    const button = pageButton(scope.kind === 'orders' ? '导出' : '主单导出');
    await prepClick(state, button, '打开导出菜单');
    const option = await waitFor(() => visibleText('[role="option"],[role="menuitem"],li', scope.kind === 'orders' ? '导出全部' : '导出全部项'), '导出全部菜单', 8000, state);
    await pace(state);
    // Persist intent BEFORE the irreversible task submission. A reload only monitors it.
    state.intent = { kind: scope.kind, scope, baseline, submittedAt: Date.now(), title: '', clickedAt: 0 };
    state.stage = 'prep_task'; saveState(state); assertActive(state);
    option.click();
  }

  function taskDownloadControl(task) {
    const right = task.item.querySelector('.cn-ui-async-jobs-pro-item-right');
    // cn-ui binds the download callback to the inner SVG, not its i/div containers.
    const icons = [...(right?.querySelectorAll('svg') || [])].filter(shown);
    const targets = icons.length ? icons : [...(right?.querySelectorAll('button,a[href]') || [])].filter(shown);
    return targets.length === 1 ? targets[0] : null;
  }

  function attemptTaskDownload(control) {
    if (!shown(control)) return { code: 'missing_control', status: '未识别唯一下载控件；请手动下载本批任务' };
    const originalOpen = window.open;
    let calls = 0, blocked = 0, requested = 0, failed = false, observed = false;
    const observer = function (...args) {
      calls++;
      try {
        const result = Reflect.apply(originalOpen, this, args);
        if (result === null) blocked++;
        else if (result) requested++;
        return result;
      } catch (error) { failed = true; throw error; }
    };
    try {
      // Observe only this synchronous click. Never retain URL arguments or returned windows.
      try { window.open = observer; observed = window.open === observer; } catch { /* keep the page's original function */ }
      control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch { failed = true; }
    finally { if (observed) window.open = originalOpen; }
    if (failed) return { code: 'error', status: '下载回调或窗口请求出现异常；请手动下载本批任务并导入核对' };
    if (!observed) return { code: 'unconfirmed', status: '下载尝试未能确认；请手动下载本批任务并导入核对' };
    if (!calls) return { code: 'no_window_request', status: '未观察到下载窗口请求，事件可能未进入页面下载回调；请手动下载本批任务' };
    if (blocked) return { code: 'blocked', status: '已触发下载回调，但浏览器拦截下载窗口；请手动下载，或仅允许菜鸟本站弹窗后重新下载本批文件' };
    if (requested === calls) return { code: 'requested', status: '已请求下载窗口；尚不能证明文件已保存，请导入实际文件核对' };
    return { code: 'unconfirmed', status: '已触发下载回调，窗口结果未确认；请手动下载并导入核对' };
  }

  async function redownloadPrepared(state) {
    await openTasks(state);
    await waitFor(() => state.exports.every((record) => exportTasks().some((task) =>
      task.title === record.title && task.status === '已完成')), '本批已完成任务加载', 15000, state);
    while (state.redownloadIndex < state.exports.length) {
      assertActive(state); prepPageError();
      const record = state.exports[state.redownloadIndex];
      const matches = exportTasks().filter((task) => task.title === record.title);
      if (matches.length !== 1 || matches[0].status !== '已完成') throw new PauseError(`本批任务尚不可下载：${record.title}；未重新导出`);
      const control = taskDownloadControl(matches[0]);
      await pace(state); assertActive(state);
      const attempt = attemptTaskDownload(control);
      record.downloadAttemptedAt = Date.now(); record.downloadCode = attempt.code; record.downloadStatus = attempt.status;
      state.redownloadIndex++; saveState(state);
    }
    state.active = false; state.stage = 'prep_files';
    prepNote(state, '已尝试本批任务下载，尚不能证明文件已保存。先检查浏览器实际文件，已保存可直接选择导入；未保存或被拦再按任务状态手动下载或仅允许菜鸟本站弹窗；未重新导出。');
  }

  async function monitorExport(state) {
    const intent = state.intent;
    if (!intent) throw new Error('导出任务记录缺失');
    await openTasks(state);
    prepNote(state, `等待${intent.kind === 'orders' ? '订单' : '销退'}导出任务生成；不会重复提交。`);
    const end = Date.now() + 600000;
    let task;
    while (Date.now() < end) {
      assertActive(state); prepPageError();
      task = newTask(intent, exportTasks());
      if (!task && Date.now() - intent.submittedAt > 20000) throw new PauseError('未识别到本批新导出任务，请检查任务列表；续跑只核对已有任务，不会重复提交');
      if (task) {
        if (!intent.title) { intent.title = task.title; saveState(state); }
        if (/失败|取消|异常/.test(task.status)) throw new PauseError(`导出任务${task.status}：${task.title}`);
        if (task.status === '已完成') break;
        prepNote(state, `等待文件：${task.title}（${task.status || '处理中'}）`);
      }
      await sleep(2000);
    }
    if (!task || task.status !== '已完成') throw new PauseError('后台导出等待超过10分钟；可稍后续跑继续检查此任务');
    if (!intent.clickedAt) {
      const download = taskDownloadControl(task);
      await pace(state);
      intent.clickedAt = Date.now(); saveState(state); assertActive(state);
      const attempt = attemptTaskDownload(download);
      intent.downloadCode = attempt.code; intent.downloadStatus = attempt.status; saveState(state);
    }
    state.exports.push({ kind: intent.kind, title: intent.title, scope: intent.scope, clickedAt: intent.clickedAt,
      generatedAt: Date.now(), downloadCode: intent.downloadCode || 'unconfirmed',
      downloadStatus: intent.downloadStatus || '已记录下载尝试；结果未确认，请手动下载并导入核对' });
    if (intent.kind === 'orders') state.groupIndex++;
    else { state.returnScopes.push(intent.scope); state.returnQueue.shift(); }
    state.intent = null;
    state.stage = intent.kind === 'orders' ? 'prep_orders' : 'prep_returns'; saveState(state);
    await closeTasks(state);
  }

  async function runPreparation(state) {
    const currentSource = jobsFromTable(unpackTable(state.pdd));
    const validOrders = new Set(currentSource.filter((job) => !job.issue && job.refundType === '退货退款' && job.aftersaleStatus === '待商家处理').map((job) => job.order));
    if ((state.orderIds || []).some((order) => !validOrders.has(order)) || (state.groups || []).flat().some((order) => !validOrders.has(order))) {
      throw new PauseError('旧准备清单含无效源配对，请重新选择原售后表；不会重复提交已有导出任务');
    }
    while (state.active) {
      assertActive(state);
      if (state.stage === 'prep_redownload') { await redownloadPrepared(state); continue; }
      if (state.stage === 'prep_task') { await monitorExport(state); continue; }
      if (state.stage === 'prep_orders') {
        if (state.groupIndex >= state.groups.length) {
          if (!state.observedOrders.length) throw new PauseError('本批原订单全部未找到，请人工核对店铺和订单号');
          const start = state.observedOrders.map((row) => dayValue(row.created)).sort()[0];
          state.returnQueue = [{ start, end: today() }];
          state.stage = 'prep_returns'; saveState(state); continue;
        }
        if (location.pathname !== new URL(ORDER_URL).pathname) { location.assign(ORDER_URL); return; }
        prepNote(state, `查询本批原订单 ${state.groupIndex + 1}/${state.groups.length} 组（每组最多 ${ORDER_BATCH_SIZE} 个）。`);
        const scope = await queryOrders(state, state.groups[state.groupIndex]);
        // Replace this group's scan when resuming a query interrupted before task submission.
        state.observedOrders = state.observedOrders.filter((row) => !scope.ids.includes(row.order)).concat(scope.observed);
        state.missingOrders = [...new Set(state.missingOrders.filter((id) => !scope.ids.includes(id)).concat(
          scope.ids.filter((id) => !scope.observed.some((row) => row.order === id))))];
        saveState(state);
        if (scope.count === 0) { state.groupIndex++; saveState(state); continue; }
        await beginExport(state, scope); continue;
      }
      if (state.stage === 'prep_returns') {
        if (!state.returnQueue.length) {
          state.active = false; state.stage = 'prep_files';
          prepNote(state, `本批导出已生成：订单 ${state.exports.filter((task) => task.kind === 'orders').length} 份、销退 ${state.exports.filter((task) => task.kind === 'returns').length} 份；下载点击仅为尝试。先检查浏览器实际文件，已保存可直接选择导入；未保存或被拦再按任务状态手动下载或仅允许菜鸟本站弹窗。请选择本次全部菜鸟文件核对；拼多多表已保留。${state.missingOrders.length ? `未找到的 ${state.missingOrders.length} 个原订单将在匹配结果中列为需核实。` : ''}`);
          sessionStorage.setItem(PANEL_KEY, 'true'); render(); return;
        }
        if (location.pathname !== new URL(RETURN_URL).pathname) { location.assign(RETURN_URL); return; }
        const dates = state.returnQueue[0];
        prepNote(state, `查询全部状态销退：${dates.start} 至 ${dates.end}。`);
        const scope = await queryReturns(state, dates);
        if (scope.count > 10000) {
          state.returnQueue.splice(0, 1, ...splitDays(scope)); saveState(state); continue;
        }
        if (scope.count === 0) { state.returnScopes.push(scope); state.returnQueue.shift(); saveState(state); continue; }
        await beginExport(state, scope); continue;
      }
      throw new Error(`准备流程阶段无法识别：${state.stage}`);
    }
  }

  function validatePrepared(state, orders, returns) {
    orders = normalizeExportHeaders(orders);
    returns = normalizeExportHeaders(returns);
    const required = (table, names) => {
      const missing = names.filter((name) => !table.header.has(name.toLowerCase()));
      if (missing.length) throw new Error(`表格“${table.fileName}”检测类型：${tableLabel(tableKind(table))}；缺少必需列：${missing.join('、')}，请使用本次字段完整的原始导出文件`);
    };
    required(orders, ['系统单号', '订单创建', '货品ID']);
    required(returns, RETURN_HEADERS);
    const live = new Map(state.observedOrders.map((row) => [row.system, row]));
    const covered = new Map();
    for (const row of orders.rows) {
      const order = tableValue(orders, row, '交易单号');
      const system = tableValue(orders, row, '系统单号');
      const known = live.get(system);
      if (!known || known.order !== order || !state.orderIds.includes(order)) throw new Error('订单文件含本次查询以外的系统单或交易单，请选择本次下载文件');
      if (dayValue(tableValue(orders, row, '订单创建')) !== dayValue(known.created)) throw new Error('订单文件创建日期与查询结果不一致');
      const lp = tableValue(orders, row, '物流单号');
      const goodsId = tableValue(orders, row, '货品ID');
      if (known.lps.length && !known.lps.includes(lp)) throw new Error(`订单 ${order} 的 LP 与查询结果不一致`);
      if (known.goodsIds.length && !known.goodsIds.includes(goodsId)) throw new Error(`订单 ${order} 的货品 ID 与查询结果不一致`);
      if (!covered.has(system)) covered.set(system, { lps: new Set(), goodsIds: new Set() });
      covered.get(system).lps.add(lp); covered.get(system).goodsIds.add(goodsId);
    }
    if (covered.size !== live.size) throw new Error('订单文件未覆盖全部查询到的系统单，请补选全部订单分批文件');
    for (const [system, known] of live) {
      const actual = covered.get(system);
      if (known.lps.some((lp) => !actual.lps.has(lp)) || known.goodsIds.some((id) => !actual.goodsIds.has(id))) {
        throw new Error('订单文件缺少查询中出现的 LP 或货品，请补选全部分批文件');
      }
    }
    const romsRows = new Map();
    for (const row of returns.rows) {
      const roms = tableValue(returns, row, '销退ROMS单号');
      if (!/^ROMS\d+$/.test(roms)) throw new Error('销退文件缺少有效 ROMS 单号');
      if (romsRows.has(roms)) throw new Error('同一 ROMS 出现不同内容，请选择同批次文件');
      const date = dayValue(tableValue(returns, row, '销退创建时间'));
      if (!state.returnScopes.some((scope) => date >= scope.start && date <= scope.end)) throw new Error('销退文件日期超出本次范围，请选择本次下载文件');
      romsRows.set(roms, row);
    }
    for (const scope of state.returnScopes) {
      const rows = [...romsRows.values()].filter((row) => {
        const date = dayValue(tableValue(returns, row, '销退创建时间'));
        return date >= scope.start && date <= scope.end;
      });
      if (rows.length !== scope.count) throw new Error(`销退 ${scope.start} 至 ${scope.end} 应有 ${scope.count} 条，文件只有 ${rows.length} 条；请补选分批文件`);
      for (const sample of scope.samples) {
        const row = romsRows.get(sample.roms);
        if (!row || tableValue(returns, row, '状态') !== sample.status ||
          tableValue(returns, row, '正向LP单号') !== sample.lp ||
          tableValue(returns, row, '运单号') !== sample.waybill) throw new Error('销退文件与本批全部状态查询结果不一致，请重新下载');
      }
    }
  }

  async function importPrepared(state, files) {
    if (!files.length) throw new Error('请选择本次下载的全部菜鸟文件');
    const tables = [unpackTable(state.pdd)];
    for (const file of files) {
      if (file.lastModified < state.startedAt - 60000) throw new Error(`文件“${file.name}”早于本次准备，请选择新下载的文件`);
      const table = await readTable(file);
      importIdentity(state);
      if (tableKind(table) === 'pdd') throw new Error('拼多多表已保留，这一步只选菜鸟文件');
      tables.push(table);
    }
    if (!state.exports.some((task) => task.kind === 'returns')) tables.push({ fileName: '本次销退查询为空',
      sheetName: '空销退', header: new Map(RETURN_HEADERS.map((name, i) => [name.toLowerCase(), i])), rows: [] });
    const grouped = groupTables(tables);
    validatePrepared(state, grouped.get('orders'), grouped.get('returns'));
    const plan = matchTables(tables, state.confirmedResults);
    importIdentity(state);
    return { ...state, ...plan, flow: '', pdd: undefined, stage: 'ready', active: false,
      prepMessage: '', preparation: { exports: state.exports.map(({ kind, title }) => ({ kind, title })),
        missingOrders: state.missingOrders, returnScopes: state.returnScopes.map(({ start, end, count }) => ({ start, end, count })) } };
  }


  const resultKey = (row) => JSON.stringify([clean(row[0]), clean(row[1]), waybillKey(row[3])]);
  function normalizeResults(rows) {
    const groups = new Map();
    for (const row of rows || []) {
      const key = resultKey(row), old = groups.get(key);
      if (!old) { groups.set(key, row); continue; }
      const roms = [old[5], row[5]].filter((value) => /^ROMS\d+$/.test(value));
      if (new Set(roms).size > 1) throw new PauseError('同一售后、订单和运单对应不同 ROMS，已停止；请人工核实');
      // An already confirmed creation must never be downgraded by a later pause.
      if (old[4] !== '已创建' || row[4] === '已创建') groups.set(key, row);
    }
    return [...groups.values()];
  }

  function record(state, status, note = "", roms = "", newLp = "") {
    const job = state.jobs[state.index];
    const row = [job.aftersale, job.order, state.lp || "", job.waybill, status,
      roms || state.submission?.roms || '', newLp, [state.addressNote, note].filter(Boolean).join('；'), new Date().toLocaleString("zh-CN")];
    state.results = normalizeResults([...(state.results || []), row]);
    if (status === '已创建' || status === '核对通过未提交' || status === '已建跳过') state.consecutiveFailures = 0;
  }

  function displayReason(value) {
    const text = String(value || '');
    return /未查到对应正向订单/.test(text) ? '菜鸟未查到对应正向订单，暂不能创建' : text;
  }
  function businessNote(value, status) {
    let note = displayReason(value);
    const marker = /(?:表单DOM读回|表单读回)：/g;
    let match;
    while ((match = marker.exec(note))) {
      const start = marker.lastIndex;
      if (note[start] !== '{') continue;
      let depth = 0, quoted = false, escaped = false, end = start;
      for (; end < note.length; end++) {
        const ch = note[end];
        if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
        else if (ch === '"') quoted = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) { end++; break; }
      }
      if (depth || quoted) continue;
      try {
        const parsed = JSON.parse(note.slice(start, end));
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' ||
            !('phase' in parsed || 'checkedAt' in parsed || 'items' in parsed || !Object.keys(parsed).length)) continue;
      } catch { continue; }
      note = note.slice(0, match.index) + note.slice(end); marker.lastIndex = match.index;
    }
    for (const text of ['确认前表单DOM已核对LP/业务订单/货品集合/数量/物流商/运单',
      '结果页仅核对ROMS/原LP/运单，未读回结果货品数量']) note = note.split(text).join('');
    note = note.replace('旧或恢复记录无本单最终表单读回证据', '历史表单核对记录缺失，请人工复核')
      .replace(/；+/g, '；').replace(/^；|；$/g, '').trim();
    return note || (status === '核对通过未提交' ? '已核对，未提交' : '');
  }

  function csvDownload(state) {
    // Prefix spreadsheet formulas as literal text when exporting external fields.
    const quote = (value) => {
      let text = String(value ?? '');
      if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^\d{16,}$/.test(text)) text = "'" + text;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = normalizeResults(state.results).map((row) => row.map((value, index) => index === 7 ? businessNote(value, row[4]) : value));
    if (state.mode === 'three') {
      const recorded = new Set(rows.map((row) => row[0]));
      for (const job of state.jobs) {
        if (!recorded.has(job.aftersale)) rows.push(reportRow(job, state.stage === 'ready' ? job.pendingLookup ? '待补查' : '待创建' : '未处理', '尚未提交'));
      }
    }
    const lines = [HEADERS, ...rows].map((row) => row.map(quote).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff", lines], { type: "text/csv;charset=utf-8" }));
    link.download = `${state.fileName.replace(/\.xlsx$/i, "")}-菜鸟处理结果.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function next(state) {
    // A completed result must be advanced before inspecting the next page.
    assertRunning(state);
    state.index++;
    cleanJobTemporary(state);
    if (state.index >= (state.jobLimit ?? state.jobs.length)) {
      state.active = false;
      state.stage = "done";
      saveState(state);
      csvDownload(state);
    } else {
      state.stage = "cooldown";
      state.notBefore = Date.now() + BETWEEN_ORDERS_MS;
      saveState(state);
      try {
        await cooldown(state);
      } catch (error) {
        const current = loadState();
        if (!current?.active || current.id !== state.id || current.runToken !== state.runToken) return;
        pause(state, message(error));
      }
    }
  }

  async function lookup(state) {
    const job = state.jobs[state.index];
    assertJobBinding(state, true);
    if (state.lookupOrder?.jobIndex !== state.index) {
      if (location.pathname !== new URL(ORDER_URL).pathname) { location.assign(ORDER_URL); return; }
      const scope = await queryOrders(state, [job.order]);
      if (!scope.observed.length) throw new BusinessIssue('no_original_order', '菜鸟未找到该原订单，待人工核实');
      if (scope.observed.length !== 1 || scope.observed[0].order !== job.order) throw new PauseError('原订单查询未精确唯一匹配');
      const row = scope.observed[0];
      if (!row.isPdd || !row.isOutbound) throw new BusinessIssue('order_ineligible', '原订单不是拼多多已出库订单，暂不能创建');
      if (row.lps.length !== 1 || !/^LP\d{8,}$/.test(row.lps[0])) throw new PauseError('原订单没有唯一有效 LP');
      if (job.items.some((item) => item.goodsId && !row.goodsIds.includes(item.goodsId))) throw new PauseError('在线原订单货品ID与导出货品冲突');
      if (job.items.length !== 1 || row.goodsIds.length !== 1 || !/^\d+$/.test(row.goodsIds[0]) ||
          !row.goods.length || row.goods.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) {
        throw new PauseError('在线原订单货品无法唯一映射或数量无效，请人工核对');
      }
      state.lp = row.lps[0]; job.lp = state.lp;
      job.items[0].goodsId = row.goodsIds[0];
      job.mappingBinding = mappingSnapshot(job);
      state.lookupOrder = { jobIndex: state.index, order: job.order, lp: state.lp, goods: row.goods };
      saveState(state);
      location.assign(RETURN_URL); return;
    }
    if (location.pathname !== new URL(RETURN_URL).pathname) { location.assign(RETURN_URL); return; }
    const listed = await queryReturnIdentity(state, { order: job.order });
    const rows = [];
    for (const row of listed) {
      if (!returnResultRows(row.roms).length) await queryReturnIdentity(state, { roms: row.roms });
      const detail = await readReceipt(state, row.roms, { roms: row.roms, order: job.order, lp: state.lp, waybill: null });
      rows.push({ ...row, ...detail });
    }
    const same = rows.filter((row) => waybillKey(row.waybill) === waybillKey(job.waybill));
    if (same.some((row) => row.status === '销退已取消')) throw new BusinessIssue('return_conflict', '相同订单及退货运单已有取消销退，请人工核实');
    const active = rows.filter((row) => row.status !== '销退已取消');
    if (active.some((row) => waybillKey(row.waybill) !== waybillKey(job.waybill))) throw new BusinessIssue('return_conflict', '同订单存在不同有效退货运单，请核实并手动取消旧单后重选销退表');
    if (same.length > 1 || new Set(rows.map((row) => row.roms)).size !== rows.length) throw new BusinessIssue('return_conflict', '同订单或运单有重复销退，请人工核实');
    if (same.length === 1) {
      const item = job.items[0], original = state.lookupOrder.goods.filter((goods) => goods.id === item.goodsId);
      const shipped = original.reduce((sum, goods) => sum + goods.quantity, 0);
      const quantity = item.quantity ?? (shipped === 1 ? 1 : null);
      if (!quantity) throw new BusinessIssue('quantity_missing', '多件原订单缺少明确退货数量，无法判断已有销退是否匹配，请人工核实');
      const detail = await readReceipt(state, same[0].roms, { roms: same[0].roms, order: job.order, lp: state.lp, waybill: job.waybill, items: [{ goodsId: item.goodsId, quantity }] });
      record(state, '已建跳过', '在线补查确认相同订单和退货运单已有销退', detail.roms, detail.reverseLp);
      delete state.lookupOrder;
      await next(state); return;
    }
    delete state.lookupOrder;
    state.stage = 'create'; saveState(state); location.assign(CREATE_URL);
  }

  function goodsContainer(table) {
    return table.closest('.add-table') || table.closest('.cn-next-loading') || table.closest('.cn-next-table, .cn-table') ||
      (table.parentElement !== document.body ? table.parentElement : table);
  }
  function createQueryErrors() {
    const entries = pageErrors();
    for (const element of visibleAll('[role="alertdialog"], .cn-next-dialog')) {
      const text = clean(element.innerText);
      if (/未查到对应正向订单/.test(text) && !entries.some((entry) => entry.element === element)) entries.push({ element, text });
    }
    return entries;
  }
  function createResponseFence() {
    const fence = { changed: false }, oldErrors = new Map(createQueryErrors().map((entry) => [entry.element, entry.text]));
    const initialTables = visibleAll('table').filter((table) => table.innerText.includes('可退货数量'));
    const isGoods = (table) => table?.matches?.('table') && (initialTables.includes(table) || table.innerText.includes('可退货数量'));
    const insideData = (node) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      return !!el && !el.closest('#znext-cainiao-panel') && isGoods(el.closest('table'));
    };
    const replacesData = (node) => node.nodeType === 1 && !node.closest('#znext-cainiao-panel') &&
      (isGoods(node) || [...node.querySelectorAll('table')].some(isGoods));
    const observer = new MutationObserver((records) => {
      if (records.some((record) => {
        if (record.type !== 'attributes') return insideData(record.target) || [...record.addedNodes, ...record.removedNodes].some(replacesData);
        // Require goods data/loading response; title updates alone cannot certify fresh goods.
        const target = record.target;
        const local = [...new Set([...initialTables, ...visibleAll('table').filter(isGoods)])].some((table) => {
          const scope = goodsContainer(table); return scope === target || scope.contains(target);
        });
        if (!local) return false;
        return record.attributeName === 'aria-busy' && ['true', 'false'].includes(record.oldValue) ||
          record.attributeName === 'class' && /(?:^|\s)cn-next-loading(?:-indicator|-tip)?(?:\s|$)/.test(`${record.oldValue || ''} ${target.className || ''}`);
      })) fence.changed = true;
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['aria-busy', 'class'], attributeOldValue: true });
    fence.checkError = () => {
      const errors = createQueryErrors().filter((entry) => oldErrors.get(entry.element) !== entry.text);
      if (errors.some((entry) => /未查到对应正向订单[,，]?\s*请检查输入单号是否正确/.test(entry.text))) throw new BusinessIssue('no_forward_order', '菜鸟未查到对应正向订单，暂不能创建');
      if (errors.length) throw new PauseError(`原LP查询后台提示：${errors.map((entry) => entry.text).join('；')}`);
    };
    fence.close = () => observer.disconnect(); return fence;
  }
  function goodsBusy(table) {
    const scope = goodsContainer(table);
    return scope.getAttribute('aria-busy') === 'true' || [...scope.querySelectorAll('.cn-next-loading-indicator, .cn-next-loading-tip, [aria-busy="true"]')].some(shown) ||
      scope.matches('.cn-next-loading-indicator, .cn-next-loading-tip') && shown(scope);
  }

  async function create(state) {
    if (state.createConfirmationPending && !state.submission) throw new PauseError('本单创建确认阶段曾中断，请先核实页面和后台结果；禁止自动重跑或跳过');
    const job = state.jobs[state.index];
    assertJobBinding(state, true);
    if (location.pathname !== new URL(CREATE_URL).pathname) {
      location.assign(CREATE_URL);
      return;
    }
    const lpInput = await waitFor(() =>
      visibleAll('input[placeholder="请输入发货LP查询"]')[0], "发货 LP 查询框", 20000, state);
    fill(lpInput, state.lp);
    const query = await waitFor(() =>
      visibleAll("div.m-b-12 button").find((item) => clean(item.innerText) === "查询"), "发货 LP 查询按钮", 20000, state);
    await pace(state);
    const fence = createResponseFence();
    let table;
    try {
      query.click();
      let signature = '', since = 0;
      table = await waitFor(() => {
        fence.checkError();
        const ids = createIdentifiers(), tables = visibleAll('table').filter((item) => item.innerText.includes('可退货数量'));
        if (!fence.changed || ids?.order !== job.order || ids.lp !== state.lp || tables.length !== 1 || goodsBusy(tables[0])) { since = 0; return false; }
        const current = JSON.stringify([ids, clean(tables[0].innerText), [...tables[0].querySelectorAll('input')].map((input) => [input.value, input.checked, input.disabled])]);
        if (signature !== current || !since) { signature = current; since = Date.now(); return false; }
        return Date.now() - since >= 750 ? tables[0] : false;
      }, '当前交易单、发货LP及货品查询响应稳定', 20000, state);
    } finally { fence.close(); }
    const rows = [...table.querySelectorAll("tbody tr")];
    if (!rows.length || rows.every((row) => row.querySelectorAll("td").length === 1 && /没有数据|暂无数据/.test(clean(row.innerText)))) throw new BusinessIssue("goods_unavailable", "菜鸟原订单没有可退货品，暂不能创建");
    const selectedRows = new Set();
    const expected = [];
    for (const item of job.items) {
      const sku = skuKey(item.sku);
      if (!item.goodsId && sku.length < 5) throw new Error(`SKU 过短，无法可靠匹配：${item.sku}`);
      const matches = rows.filter((row) => {
        const cells = row.querySelectorAll("td");
        return cells.length >= 6 && (item.goodsId
          ? clean(cells[1].innerText) === item.goodsId
          : skuKey(cells[2].innerText) === sku);
      });
      if (!matches.length) throw new BusinessIssue("goods_unavailable", `菜鸟原订单未找到本单目标货品 ${item.goodsId || item.sku}，待人工处理`);
      if (matches.length !== 1) throw new PauseError(`${item.goodsId ? `货品 ID ${item.goodsId}` : `SKU ${item.sku}`} 匹配到 ${matches.length} 个货品`);
      const row = matches[0];
      if (selectedRows.has(row)) throw new Error('多个售后货品匹配到同一个页面货品，请人工核对');
      selectedRows.add(row);
      const cells = row.querySelectorAll("td");
      const shipped = Number(clean(cells[3].innerText));
      const available = Number(clean(cells[4].innerText));
      const quantity = item.quantity ?? (shipped === 1 ? 1 : null);
      if (!Number.isSafeInteger(shipped) || shipped < 0 || !Number.isSafeInteger(available) || available < 0) {
        throw new Error(`SKU ${item.sku} 的页面数量无法识别`);
      }
      if (!quantity) throw new BusinessIssue("quantity_missing", `SKU ${item.sku} 缺少明确退货数量，待人工处理`);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error(`SKU ${item.sku} 退货数量无效`);
      if (quantity > shipped) throw new BusinessIssue("quantity_insufficient", `SKU ${item.sku} 退货数量超过原发货数量`);
      if (quantity > available) throw new BusinessIssue("quantity_insufficient", `SKU ${item.sku} 需退 ${quantity} 件，可退仅 ${available} 件`);
      const checkbox = row.querySelector('input[type="checkbox"]');
      const quantityInput = row.querySelector('td[data-cn-next-table-col="5"] input');
      if (checkbox && isDisabled(checkbox)) throw new BusinessIssue("goods_unavailable", `SKU ${item.sku} 当前不可退货，待人工处理`);
      if (!checkbox || !quantityInput) throw new Error(`SKU ${item.sku} 的勾选或数量框不存在`);
      if (!checkbox.checked) checkbox.click();
      await waitFor(() => checkbox.checked && !isDisabled(quantityInput), '本单货品已勾选且数量可填写', 5000, state);
      fill(quantityInput, quantity);
      expected.push({ goodsId: clean(cells[1].innerText), sku: clean(cells[2].innerText), quantity });
    }
    const carrier = await waitFor(() =>
      fieldGroup("退货物流商")?.querySelector('[role="combobox"]'), "退货物流商", 20000, state);
    carrier.click();
    const other = await waitFor(() => visibleText('[role="option"]', "其他"), "物流商“其他”", 20000, state);
    other.click();
    const waybill = await waitFor(() =>
      fieldGroup("退货运单号")?.querySelector("input"), "退货运单号", 20000, state);
    fill(waybill, job.waybill);
    await completeDistrict(state);
    // Controlled inputs may update after input/change handlers return.
    await sleep(500); assertActive(state);
    assertAddressPreserved(state);
    if (state.dryRun) {
      auditCreateForm(state, expected, '核对未提交');
      record(state, "核对通过未提交", "已核对，未提交");
      await next(state);
      return;
    }
    const submit = visibleText("button", "提交");
    if (!submit) throw new Error("提交按钮不存在");
    await pace(state);
    assertAddressPreserved(state);
    assertJobBinding(state, true);
    state.createConfirmationPending = { batchId: state.id, jobIndex: state.index };
    saveState(state); assertActive(state);
    submit.click();
    await waitForConfirmation(state);
    const confirm = [...(confirmationDialog()?.querySelectorAll('button') || [])].filter(shown)
      .find((button) => clean(button.innerText) === '确定');
    if (!confirm) throw new Error("确认按钮不存在");
    await pace(state);
    assertAddressPreserved(state);
    auditCreateForm(state, expected, '最终确认前');
    state.submission = { batchId: state.id, jobIndex: state.index, aftersale: job.aftersale,
      order: job.order, waybill: job.waybill, lp: state.lp, roms: '', firstReceiptPending: true, formAuditRequired: true, submittedAt: Date.now(),
      fastReceipt: { version: '1.6.6', intent: submissionIntent(state), documentId, beforeUrl: location.href,
        previousRoms: [...new Set([...document.querySelectorAll('tbody tr')].map((row) => clean(row.querySelectorAll('td')[1]?.innerText))
          .concat((state.results || []).map((row) => clean(row[5]))).filter((id) => /^ROMS\d+$/.test(id)))] } };
    delete state.createConfirmationPending;
    state.stage = "verify";
    saveState(state);
    assertActive(state);
    confirm.click();
    // Keep the receipt ticket unclaimed while a real document navigation is pending.
    // The first result document claims it before any receipt wait or lookup.
    try {
      await waitFor(() => location.pathname === new URL(RETURN_URL).pathname && /^ROMS\d+$/.test(clean(new URL(location.href).searchParams.get('orderCode'))),
        '新建结果页面', 25000, state);
    } catch (error) {
      if (!/超时/.test(message(error))) throw error;
      await verify(state, true); return;
    }
    await verify(state, false);
  }

  function auditCreateForm(state, expected, phase) {
    const job = state.jobs[state.index];
    assertJobBinding(state, true);
    const queryLp = clean(visibleAll('input[placeholder="请输入发货LP查询"]')[0]?.value);
    const ids = createIdentifiers();
    if (queryLp !== state.lp || ids?.lp !== state.lp || ids.order !== job.order) {
      throw new PauseError('当前页面回显发货LP或交易单与目标不匹配，请人工核实');
    }
    const lp = ids.lp;
    const tables = visibleAll('table').filter((table) => table.innerText.includes('可退货数量'));
    if (tables.length !== 1 || goodsBusy(tables[0])) throw new PauseError('无法唯一读回已加载完成的当前可退货货品表，请人工核实');
    const selected = [...tables[0].querySelectorAll('tbody tr')].filter((row) => row.querySelector('input[type="checkbox"]')?.checked)
      .map((row) => {
        const cells = row.querySelectorAll('td');
        const input = row.querySelector('td[data-cn-next-table-col="5"] input');
        const quantity = Number(input?.value), shipped = Number(clean(cells[3]?.innerText)), available = Number(clean(cells[4]?.innerText));
        if (isDisabled(input) || !Number.isSafeInteger(quantity) || quantity <= 0 ||
            !Number.isSafeInteger(shipped) || !Number.isSafeInteger(available) || quantity > available || quantity > shipped) {
          throw new PauseError('最终确认前货品数量或可退范围已变化，请人工核实');
        }
        return { goodsId: clean(cells[1]?.innerText), sku: clean(cells[2]?.innerText), quantity };
      });
    if (selected.length !== expected.length || expected.some((want) => selected.filter((got) =>
      got.goodsId === want.goodsId && got.sku === want.sku && got.quantity === want.quantity).length !== 1)) {
      throw new PauseError('页面实际勾选货品集合或退货数量与目标不一致，请人工核实');
    }
    const group = fieldGroup('退货物流商');
    const control = group?.querySelector('[role="combobox"]');
    const carrier = clean(control?.getAttribute('aria-valuetext') || group?.querySelector('em')?.innerText || control?.innerText);
    const waybill = clean(fieldGroup('退货运单号')?.querySelector('input')?.value);
    if (carrier !== '其他' || waybill !== job.waybill) throw new PauseError('页面物流商或退货运单号读回不匹配，请人工核实');
    state.formAudit = { phase, batchId: state.id, jobIndex: state.index, aftersale: job.aftersale, checkedAt: new Date().toISOString(), lp: clean(lp), order: job.order,
      items: selected, carrier, waybill, scope: '创建表单同次核对交易订单、原LP、源退货运单、货品及数量' };
    saveState(state);
  }

  function returnResultRows(roms) {
    return identityListRows().filter((row) => clean(row.querySelectorAll('td')[1]?.innerText) === roms);
  }

  function returnResultRow(roms) {
    const rows = returnResultRows(roms);
    if (rows.length !== 1) throw new Error(`销退结果精确匹配到 ${rows.length} 条记录，请人工核实`);
    const row = rows[0], cells = [...row.querySelectorAll('td')];
    const headerScope = row.closest('.cn-table') || row.closest('table');
    const headers = [...(headerScope?.querySelectorAll('thead th') || [])].map((cell) => clean(cell.innerText).replace(/\s/g, ''));
    if (cells.length < 7 || headers.length !== cells.length ||
        !/^(销退交易单|销退ROMS单号|销退交易单号)$/.test(headers[1]) ||
        !/^(销退单号|逆向LP单号)$/.test(headers[2]) || !/^(退货状态|销退状态|状态)$/.test(headers[3]) || !/^(运单号|退货运单号)$/.test(headers[4]) ||
        !/^(关联发货物流单|关联发货物流单号|原发货LP|正向LP单号)$/.test(headers[6])) {
      throw new Error('销退结果列标题或结构无法核实，请人工核实');
    }
    return { row, roms: clean(cells[1].innerText), reverseLp: clean(cells[2].innerText),
      waybill: clean(cells[4].innerText), lp: clean(cells[6].innerText), status: clean(cells[3].innerText) };
  }

  function returnDetail() {
    const drawers = visibleAll('div.cn-next-drawer[role="dialog"]').filter((drawer) => drawer.innerText.includes('销退单详情'));
    if (drawers.length > 1) throw new Error('可见销退单详情不唯一，请人工核实');
    if (!drawers.length) return null;
    const drawer = drawers[0], values = new Map();
    for (const control of drawer.querySelectorAll('.cn-ui-form-item-control')) {
      const pair = control.children[0];
      const label = clean(pair?.children[0]?.querySelector('span')?.innerText);
      const value = clean(pair?.children[1]?.innerText);
      if (!label) continue;
      if (!values.has(label)) values.set(label, []);
      values.get(label).push(value);
    }
    const result = { drawer };
    for (const [field, label] of Object.entries({ roms: '销退交易单', reverseLp: '销退单号',
      waybill: '运单号', lp: '关联发货物流单号', order: '交易单号' })) {
      const entries = values.get(label) || [];
      if (entries.length > 1) throw new Error(`销退详情字段“${label}”不唯一，请人工核实`);
      result[field] = entries[0] || '';
    }
    return result;
  }

  function receiptGoods(drawer) {
    const headers = [...drawer.querySelectorAll('table')].filter((table) => {
      const names = [...table.querySelectorAll('thead th')].map((cell) => clean(cell.innerText).replace(/\s/g, ''));
      return names.length === 3 && names[0] === '货品ID' && names[1] === '货品名称' && names[2] === '数量';
    });
    if (headers.length > 1) throw new PauseError('销退详情货品区域不唯一，请人工核实');
    if (!headers.length) return null;
    const scope = headers[0].closest('.cn-table');
    if (!scope || !drawer.contains(scope)) throw new PauseError('销退详情货品表所属区域无法核实');
    const bodies = [...scope.querySelectorAll('table')].filter((table) => table.querySelector('tbody'));
    if (bodies.length !== 1) throw new PauseError('销退详情货品数据表不唯一，请人工核实');
    if (goodsBusy(bodies[0]) || scope.getAttribute('aria-busy') === 'true') return null;
    const rows = [...bodies[0].querySelectorAll('tbody tr')], items = [], ids = new Set();
    if (!rows.length) return null;
    for (const row of rows) {
      const cells = [...row.querySelectorAll('td')];
      if (cells.length !== 3) throw new PauseError('销退详情货品列结构无法核实');
      const goodsId = clean(cells[0].innerText), quantityText = clean(cells[2].innerText);
      if (!goodsId || !quantityText || /^[-—–\s]+$/.test(goodsId + quantityText)) return null;
      const quantity = Number(quantityText);
      if (!/^\d+$/.test(goodsId) || !/^[1-9]\d*$/.test(quantityText) || !Number.isSafeInteger(quantity) || ids.has(goodsId)) throw new PauseError('销退详情货品 ID 或数量无效、重复');
      ids.add(goodsId); items.push({ goodsId, quantity });
    }
    return items;
  }
  function assertReceiptItems(actual, expected) {
    if (!actual || actual.length !== expected.length || expected.some((want) => actual.filter((got) =>
      got.goodsId === want.goodsId && got.quantity === want.quantity).length !== 1)) {
      throw new PauseError('销退结果货品或数量与本单目标不一致，请人工核实；禁止重提');
    }
  }

  function identityInput(kind) {
    const combined = document.getElementById('complicateCode');
    if (shown(combined) && combined.matches('input')) return combined;
    const id = kind === 'roms' ? 'returnOrderCode' : 'orderCode';
    const label = kind === 'roms' ? '销退交易单' : '交易单号';
    const byId = document.getElementById(id);
    if (shown(byId) && byId.matches('input')) return byId;
    const groups = visibleAll('.form-item, .cn-next-form-item, .cn-ui-form-item').filter((item) => {
      const title = clean(item.querySelector('label, .form-item-title, .cn-next-form-item-label')?.innerText).replace(/[:：*\s]/g, '');
      return title === label;
    });
    const inputs = groups.flatMap((group) => [...group.querySelectorAll('input')].filter(shown));
    if (inputs.length !== 1) throw new PauseError(`无法唯一定位${label}查询框`);
    return inputs[0];
  }

  function returnFormReady(kind, value = null, allowResidual = false) {
    let input;
    try { input = identityInput(kind); } catch { return null; }
    const form = input.closest('form, .cn-next-form'), reset = queryButton('重置'), query = queryButton('查询');
    if (!selectedTab('全部(') || !form || !queryVisible(input) || isDisabled(input) || isDisabled(reset) || isDisabled(query)) return null;
    const others = [...form.querySelectorAll('input')].filter((el) => el !== input);
    const allowed = (control) => { const selected = filterValue(control); return !selected ||
      control.id === 'channelCode' && selected === '全部' || control.id === 'storeType' && selected === '保税中心仓'; };
    const controls = [...form.querySelectorAll('[role="combobox"]')];
    if (!allowResidual && (others.some((el) => clean(el.value) && !(el.matches('[role="combobox"]') && allowed(el))) || controls.some((el) => !allowed(el)))) return null;
    if (value !== null && clean(input.value) !== value) return null;
    return [input, form, reset, query, clean(input.value), ...others.map((el) => el.value), ...controls.map(filterValue)];
  }
  async function prepareReturnFilter(state, kind) {
    await closeTasks(state);
    const tab = await waitFor(() => visibleAll('[role="tab"]').find((el) => clean(el.innerText).startsWith('全部(')), '全部状态销退标签', 20000, state);
    if (!selectedTab('全部(')) await prepClick(state, tab, '全部状态销退');
    await waitFor(addressStableCheck(() => returnFormReady(kind, null, true)), '销退身份查询表单稳定', 15000, state);
    if (returnFormReady(kind, '')) return;
    await pace(state); assertActive(state);
    const reset = queryButton('重置');
    if (isDisabled(reset)) throw new PauseError('销退重置控件尚不可用');
    reset.click();
    await waitFor(addressStableCheck(() => returnFormReady(kind, '')), '销退筛选清空及控件稳定', 15000, state);
  }
  async function queryReturnIdentity(state, identity) {
    if (location.pathname !== new URL(RETURN_URL).pathname) throw new PauseError('请在销退页面恢复结果核对');
    const kind = identity.roms ? 'roms' : 'order', value = identity[kind];
    if (!value || kind === 'roms' && !/^ROMS\d+$/.test(value)) throw new PauseError('销退查询没有有效身份');
    await prepareReturnFilter(state, kind);
    await pace(state); assertActive(state);
    const ready = returnFormReady(kind, '');
    if (!ready) throw new PauseError('销退筛选控件或空条件发生变化，未查询');
    fill(ready[0], value); ready[0].dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    await waitFor(addressStableCheck(() => returnFormReady(kind, value)), '销退身份输入及控件稳定', 10000, state);
    const check = () => { if (!returnFormReady(kind, value)) throw new PauseError('销退查询身份、全部状态或筛选条件发生变化'); };
    await pace(state); assertActive(state); check();
    const query = queryButton('查询');
    if (isDisabled(query)) throw new PauseError('销退身份查询按钮不可用');
    const fence = queryFence();
    try {
      query.click();
      if (kind === 'roms') {
        const result = await querySnapshot(state, (sample) => {
          check();
          const rows = identityListRows(), targets = rows.filter((row) => clean(row.querySelectorAll('td')[1]?.innerText) === value);
          const ids = rows.map((row) => clean(row.querySelectorAll('td')[1]?.innerText));
          sample.rows = rows.length; sample.targetRows = targets.length; sample.roms = ids;
          if (targets.length > 1) throw new PauseError('销退查询出现重复目标ROMS');
          if (sample.count > 1 || ids.some((id) => /^ROMS\d+$/.test(id) && id !== value)) return false;
          const actions = targets.length === 1 ? [...targets[0].querySelectorAll('a,button,[role="button"]')].filter(queryVisible).filter((el) => clean(el.innerText) === '查看详情') : [];
          sample.detailEntrances = actions.length;
          if (actions.length > 1) throw new PauseError('目标销退详情入口不唯一');
          return sample.count === 1 && rows.length === 1 && targets.length === 1 && actions.length === 1 ? { roms: value } : false;
        }, '精确ROMS查询一致快照', fence, 15000);
        return [result];
      }
      const observed = [], seen = new Set();
      let count = null;
      for (let page = 0; page < 1000; page++) {
        const snapshot = await querySnapshot(state, (sample) => {
          check();
          let rows;
          try { rows = returnRows(identityListRows()); } catch (error) { sample.partialRows = message(error); return false; }
          sample.rows = rows.length;
          const next = visibleAll('button[aria-label^="下一页"]').filter(queryVisible)[0], lastPage = isDisabled(next);
          if (sample.count === null || count !== null && sample.count !== count ||
              lastPage && observed.length + rows.length !== sample.count) return false;
          return { count: sample.count, rows, lastPage };
        }, '订单历史销退完整分页', fence);
        count ??= snapshot.count;
        for (const row of snapshot.rows) {
          if (seen.has(row.roms)) throw new PauseError('销退查询出现重复 ROMS');
          seen.add(row.roms); observed.push(row);
        }
        if (snapshot.lastPage) return observed;
        await pace(state); assertActive(state); check(); fence.changed = false;
        const next = visibleAll('button[aria-label^="下一页"]').filter(queryVisible)[0];
        if (isDisabled(next)) throw new PauseError('销退分页控件发生变化');
        next.click();
      }
      throw new PauseError('销退查询分页超出上限');
    } finally { fence.close(); }
  }

  async function readReceipt(state, roms, expected = null) {
    const job = state.jobs[state.index];
    const present = (value) => !!clean(value) && !/^[-—–\s]+$/.test(clean(value));
    const want = expected || { roms, order: job.order, lp: state.lp, waybill: job.waybill };
    let detail = returnDetail();
    if (detail && detail.roms && detail.roms !== roms) {
      const close = [...detail.drawer.querySelectorAll('button, [role="button"], .cn-next-drawer-close')].filter(shown)
        .find((el) => clean(el.innerText) === '关闭' || el.classList.contains('cn-next-drawer-close'));
      if (!close) throw new PauseError('其他销退详情已打开且无法安全关闭');
      await prepClick(state, close, '关闭其他销退详情');
      await waitFor(() => !returnDetail(), '关闭其他销退详情', 5000, state); detail = null;
    }
    if (!detail) {
      await waitFor(() => {
        const rows = returnResultRows(roms);
        if (rows.length > 1) throw new PauseError('销退结果存在重复 ROMS');
        return rows.length === 1;
      }, '本次销退结果记录', 20000, state);
      const rows = returnResultRows(roms);
      const actions = [...rows[0].querySelectorAll('a,button,[role="button"]')].filter(shown)
        .filter((element) => clean(element.innerText) === '查看详情');
      if (actions.length !== 1) throw new PauseError('销退查看详情入口不唯一');
      await prepClick(state, actions[0], '打开销退详情');
    }
    await waitFor(addressStableCheck(() => {
      detail = returnDetail();
      if (!detail) return false;
      for (const field of ['roms', 'order', 'lp', 'waybill']) {
        if (present(detail[field]) && want[field] != null && detail[field] !== want[field]) {
          throw new PauseError(`销退详情${field}与目标不一致`);
        }
      }
      return ['roms', 'order', 'lp', 'waybill'].every((key) => present(detail[key])) ?
        [detail.drawer, detail.roms, detail.order, detail.lp, detail.waybill] : false;
    }), '销退单详情完整字段稳定', 15000, state);
    assertActive(state); detail = returnDetail();
    if (!detail || ['roms', 'order', 'lp', 'waybill'].some((key) => !present(detail[key]) ||
        want[key] != null && detail[key] !== want[key])) throw new PauseError('销退详情身份核对失败');
    let items = null;
    if (want.items) {
      await waitFor(addressStableCheck(() => {
        const current = returnDetail();
        if (!current || current.roms !== roms) throw new PauseError('销退详情归属发生变化');
        const goods = receiptGoods(current.drawer);
        return goods ? [current.drawer, JSON.stringify(goods)] : false;
      }), '销退详情货品及数量加载稳定', 15000, state);
      items = receiptGoods(returnDetail().drawer); assertReceiptItems(items, want.items);
    }
    return { roms: detail.roms, order: detail.order, lp: detail.lp, waybill: detail.waybill, items,
      reverseLp: /^LP\d{8,}$/.test(detail.reverseLp) ? detail.reverseLp : '' };
  }

  function recoverSubmission(state) {
    const job = state.jobs?.[state.index];
    if (!job || state.stage === 'done') return false;
    if (state.createConfirmationPending && !state.submission) throw new PauseError('本单创建确认阶段曾中断，请先核实页面和后台结果；禁止自动重跑或跳过');
    const key = resultKey([job.aftersale, job.order, '', job.waybill]);
    const rows = (state.results || []).filter((row) => resultKey(row) === key);
    const current = state.submission;
    const bound = current && current.batchId === state.id && current.jobIndex === state.index &&
      current.aftersale === job.aftersale && current.order === job.order && current.waybill === job.waybill;
    const lpIds = [...new Set([current?.lp, state.lp, job.lp, ...rows.map((row) => row[2])].filter(Boolean))];
    if (current && (!bound || lpIds.length !== 1 || !/^LP\d{8,}$/.test(lpIds[0]))) throw new PauseError('提交标记归属不明确或原LP冲突，禁止重提');
    if (lpIds.length > 1) throw new PauseError('恢复记录原LP冲突，禁止重提');
    const pending = bound || state.stage === 'verify' || state.resumeStage === 'verify' ||
      rows.some((row) => row[4] === '已创建' || row[4] === '需人工核实');
    if (!pending) return false;
    const urlRoms = location.pathname === new URL(RETURN_URL).pathname ? clean(new URL(location.href).searchParams.get('orderCode')) : '';
    const storedIds = [current?.roms, ...rows.map((row) => row[5])].filter((id) => /^ROMS\d+$/.test(id));
    const ids = [...new Set(storedIds)];
    if (ids.length > 1) throw new PauseError('当前任务存在不同 ROMS，禁止重提');
    state.submission = current || { batchId: state.id, jobIndex: state.index, aftersale: job.aftersale,
      order: job.order, waybill: job.waybill, lp: state.lp || job.lp || rows.find((row) => row[2])?.[2] || '', submittedAt: 0 };
    if (ids[0]) state.submission.roms = ids[0];
    else if (/^ROMS\d+$/.test(urlRoms)) state.submission.candidateRoms = urlRoms;
    state.lp = state.submission.lp || state.lp;
    state.stage = 'verify'; return true;
  }

  function submissionIntent(state) {
    const job = state.jobs?.[state.index];
    return JSON.stringify([state.id, state.index, job?.aftersale, job?.order, job?.waybill, state.lp,
      bindingSnapshot(job), mappingSnapshot(job), job?.sourceBinding, state.formAudit]);
  }

  function finalAuditBound(state) {
    const audit = state.formAudit, job = state.jobs[state.index];
    return audit?.phase === '最终确认前' && audit.batchId === state.id && audit.jobIndex === state.index &&
        audit.aftersale === job.aftersale && audit.order === job.order && audit.lp === state.lp && audit.waybill === job.waybill &&
        Array.isArray(audit.items) && audit.items.length === job.items.length && audit.items.every((item) => /^\d+$/.test(item.goodsId) && Number.isSafeInteger(item.quantity) && item.quantity > 0) &&
        new Set(audit.items.map((item) => item.goodsId)).size === audit.items.length && job.items.every((item) => audit.items.filter((got) =>
          (item.goodsId ? item.goodsId === got.goodsId : skuKey(item.sku) === skuKey(got.sku)) && got.quantity === (item.quantity ?? 1)).length === 1);
  }

  function assertFastReceiptBinding(state, ticket) {
    assertActive(state); assertJobBinding(state, true);
    const current = loadState();
    if (!finalAuditBound(state) || submissionIntent(state) !== ticket.intent ||
        !current?.submission || current.index !== state.index || current.submission.fastReceipt?.intent !== ticket.intent ||
        ['batchId', 'jobIndex', 'aftersale', 'order', 'lp', 'waybill'].some((key) => current.submission[key] !== state.submission[key]) ||
        submissionIntent(current) !== ticket.intent) throw new PauseError('本单最终表单核对、源售后行或提交归属已变化，禁止记录成功或重提');
  }

  async function fastReceipt(state, ticket) {
    assertFastReceiptBinding(state, ticket);
    const roms = clean(new URL(location.href).searchParams.get('orderCode'));
    if (location.pathname !== new URL(RETURN_URL).pathname || !/^ROMS\d+$/.test(roms) ||
        location.href === ticket.beforeUrl || !Array.isArray(ticket.previousRoms) || ticket.previousRoms.includes(roms)) return null;
    if (state.submission.roms && state.submission.roms !== roms) throw new PauseError('新建销退结果与已保存的 ROMS 不一致，禁止记录成功或重提');
    let receipt = null;
    try {
      receipt = await waitFor(() => {
        assertFastReceiptBinding(state, ticket);
        if (clean(new URL(location.href).searchParams.get('orderCode')) !== roms || location.pathname !== new URL(RETURN_URL).pathname) throw new PauseError('新建销退结果页面身份已变化，禁止记录成功或重提');
        const targets = returnResultRows(roms);
        if (targets.length > 1) throw new PauseError('销退结果存在重复 ROMS');
        if (targets.length !== 1 || listingLoading()) return false;
        let row;
        try { row = returnResultRow(roms); } catch { return false; }
        const present = (value) => !!value && !/^[-—–\s]+$/.test(value);
        if (present(row.lp) && row.lp !== state.lp || present(row.waybill) && row.waybill !== state.jobs[state.index].waybill) throw new PauseError('新建销退结果原LP或退货运单与本单不一致，禁止记录成功或重提');
        if (/取消|失败|异常/.test(row.status)) throw new PauseError('销退结果已取消、失败或异常，禁止记录成功或重提');
        if (!/^LP\d{8,}$/.test(row.lp) || !present(row.waybill) ||
            !/^(?:销退)?(?:待收货|收货中|已收货|待入库|入库中|已入库|已完成|完成|已创建|待审核|审核中|审核通过|处理中)$/.test(row.status)) return false;
        return { roms: row.roms, reverseLp: /^LP\d{8,}$/.test(row.reverseLp) ? row.reverseLp : '',
          order: state.jobs[state.index].order, lp: row.lp, waybill: row.waybill, items: state.formAudit.items, status: row.status };
      }, '本次新建销退完整回执', 3000, state);
    } catch (error) { if (!/超时/.test(message(error))) throw error; }
    if (receipt) assertFastReceiptBinding(state, ticket);
    return receipt;
  }

  async function verify(state, recovery = true) {
    let roms = '', newLp = '';
    try {
      recoverSubmission(state);
      const ticket = state.submission?.fastReceipt;
      const fresh = !recovery && state.submission?.firstReceiptPending && !state.forceFreshVerification &&
        ticket?.version === '1.6.6' && (ticket.documentId === documentId || performance.getEntriesByType('navigation')[0]?.type !== 'reload');
      if (fresh) assertFastReceiptBinding(state, ticket);
      // Persist the one-shot claim before receipt waits; another run can only recover slowly.
      if (state.submission?.firstReceiptPending) { state.submission.firstReceiptPending = false; saveState(state); }
      if (fresh) {
        const receipt = await fastReceipt(state, ticket);
        if (receipt) {
          roms = receipt.roms; newLp = receipt.reverseLp;
          state.submission.roms = roms; delete state.submission.candidateRoms;
          state.resultAudit = { batchId: state.id, jobIndex: state.index, aftersale: state.jobs[state.index].aftersale,
            checkedAt: new Date().toISOString(), ...receipt, scope: '最终表单源任务核对及本次新建结果ROMS、原LP、退货运单和状态核对' };
          record(state, '已创建', '', roms, newLp); saveState(state);
          await next(state); return;
        }
        recovery = true;
      } else recovery = true;
      let recoveredReceipt = null;
      if (recovery && !state.submission?.roms) {
        state.forceFreshVerification = true; saveState(state);
        if (location.pathname !== new URL(RETURN_URL).pathname) { location.assign(RETURN_URL); return; }
        const job = state.jobs[state.index], listed = await queryReturnIdentity(state, { order: job.order });
        const matches = [];
        for (const row of listed) {
          if (!returnResultRows(row.roms).length) await queryReturnIdentity(state, { roms: row.roms });
          const detail = await readReceipt(state, row.roms, { roms: row.roms, order: job.order, lp: state.lp, waybill: null });
          if (detail.waybill !== job.waybill) continue;
          if (row.status === '销退已取消') throw new PauseError('本单对应销退已取消，禁止自动重提');
          matches.push(detail);
        }
        if (matches.length !== 1) throw new PauseError(`已提交任务按订单和运单精确匹配到 ${matches.length} 个有效销退，禁止重提`);
        recoveredReceipt = matches[0]; state.submission.roms = recoveredReceipt.roms;
      }
      if (!state.submission?.roms && !recoveredReceipt) {
        await waitFor(() => location.pathname === new URL(RETURN_URL).pathname && /^ROMS\d+$/.test(clean(new URL(location.href).searchParams.get('orderCode'))),
          '新建结果页面', 25000, state);
        state.submission.candidateRoms = clean(new URL(location.href).searchParams.get('orderCode'));
      }
      roms = state.submission.roms || state.submission.candidateRoms || '';
      if (location.pathname === new URL(RETURN_URL).pathname) state.submission.firstReceiptPending = false;
      saveState(state);
      if (location.pathname !== new URL(RETURN_URL).pathname) { location.assign(RETURN_URL); return; }
      if (!recoveredReceipt) {
        const open = returnDetail(), rows = returnResultRows(roms);
        if (rows.length > 1) throw new PauseError('销退结果存在重复 ROMS');
        // Normal submission can use its result row immediately; recovery always queries saved ROMS.
        if (!recovery && !rows.length && !open) {
          try { await waitFor(() => returnResultRows(roms).length > 0, '本次销退结果记录', 3000, state); }
          catch (error) { if (!/超时/.test(message(error))) throw error; }
        }
        if (recovery || !returnResultRows(roms).length && !returnDetail()) await queryReturnIdentity(state, { roms });
      }
      const audit = state.formAudit, job = state.jobs[state.index];
      const audited = finalAuditBound(state);
      if (state.submission.formAuditRequired && !audited) throw new PauseError('本单提交前货品核对记录缺失或偏离源任务，禁止记录成功或重提');
      if (audited && recoveredReceipt && !returnResultRows(roms).length) await queryReturnIdentity(state, { roms });
      const detail = audited ? await readReceipt(state, roms, { roms, order: job.order, lp: state.lp, waybill: job.waybill, items: audit.items })
        : recoveredReceipt || await readReceipt(state, roms); newLp = detail.reverseLp;
      if (!returnResultRows(detail.roms).length) await queryReturnIdentity(state, { roms: detail.roms });
      const receiptRows = returnResultRows(detail.roms);
      const receiptStatus = receiptRows.length === 1 ? clean(receiptRows[0].querySelectorAll('td')[3]?.innerText) : '';
      if (!receiptStatus || /^[-—–\s]+$/.test(receiptStatus) || /取消|失败|异常/.test(receiptStatus)) throw new PauseError('销退结果状态缺失、已取消或异常，禁止记录成功或重提');
      state.submission.roms = detail.roms; delete state.submission.candidateRoms;
      saveState(state);
      state.resultAudit = { batchId: state.id, jobIndex: state.index, aftersale: state.jobs[state.index].aftersale,
        checkedAt: new Date().toISOString(), ...detail, scope: '销退详情四项精确核对；逆向LP仅附属输出' };
      record(state, '已创建', audited ? '' : '历史表单核对记录缺失，请人工复核货品和数量', roms, newLp);
      saveState(state);
    } catch (error) {
      const current = loadState();
      if (!current?.active || current.id !== state.id || current.runToken !== state.runToken) return;
      if (!/不同 ROMS|归属不明确/.test(message(error))) record(state, '需人工核实', `提交后状态不明确：${message(error)}${state.submission?.candidateRoms && !state.submission.roms ? `；候选销退单号 ${state.submission.candidateRoms} 尚未确认归属` : ''}`, state.submission?.roms || '', newLp);
      pause(state, message(error)); return;
    }
    await next(state);
  }

  async function run(state, takeover = false) {
    if (takeover && state.flow !== 'prepare') state.forceFreshVerification = true;
    if (!navigator.locks?.request || sessionStorage.getItem(TAB_ID_KEY) !== tabId) {
      pause(state, '当前环境不支持可靠跨标签执行互斥，已安全停止'); return;
    }
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) { pause(state, '另一标签正在执行，未排队；请回到执行标签处理'); return; }
      const owner = executionOwner();
      if (owner?.id === state.id && (owner.revision || 0) !== (state.executionRevision || 0) && !takeover) {
        pause(state, '此标签批次快照落后于共享执行进度，已阻止重放；可显式接管最新进度'); return;
      }
      if (owner && owner.active && (owner.tabId !== tabId || owner.id !== state.id) && !takeover) {
        pause(state, '本批执行归属另一标签；刷新或跳转由原标签恢复。确认原标签停止后可显式接管'); return;
      }
      if (owner?.id === state.id && !owner.active && state.active && state.runToken === owner.checkpoint?.runToken && !takeover) {
        pause(state, '共享记录已停止或完成，阻止复制标签自动重放；请核对后显式接管'); return;
      }
      if (takeover && owner?.id === state.id && owner.checkpoint) {
        const token = state.runToken;
        Object.assign(state, owner.checkpoint);
        state.runToken = token;
        if (state.flow !== 'prepare') state.forceFreshVerification = true;
        if (['done', 'ready', 'prep_files'].includes(state.stage)) {
          state.active = false; saveState(state); return;
        }
        if (['paused', 'stopped'].includes(state.stage)) state.stage = state.resumeStage || state.stage;
        delete state.resumeStage;
        state.active = true;
      }
      delete state.resumeStage;
      localStorage.setItem(EXECUTION_KEY, JSON.stringify({ tabId, id: state.id,
        revision: state.executionRevision || 0, active: state.active, checkpoint: state }));
      executing = true;
      try { await runOwned(state); }
      finally { executing = false; }

    });
  }

  async function runOwned(state) {
    try {
      assertActive(state);
      if (state.flow !== 'prepare' && recoverSubmission(state)) saveState(state);
      if (state.flow !== 'prepare' && state.stage !== 'done') assertJobBinding(state, state.stage !== 'verify');
      if (state.flow === 'prepare') await runPreparation(state);
      else if (state.stage === "lookup") await lookup(state);
      else if (state.stage === "create") await create(state);
      else if (state.stage === "verify") {
        const currentRoms = clean(new URL(location.href).searchParams.get('orderCode'));
        const firstResult = state.submission?.firstReceiptPending && state.submission.fastReceipt?.version === '1.6.6' && !state.forceFreshVerification &&
          performance.getEntriesByType('navigation')[0]?.type !== 'reload' &&
          (!state.submission.roms || currentRoms === state.submission.roms);
        await verify(state, !firstResult);
      }
      else if (state.stage === "cooldown") await cooldown(state);
    } catch (error) {
      const current = loadState();
      if (!current?.active || current.id !== state.id || current.runToken !== state.runToken) return;
      if (state.flow === 'prepare') {
        pause(state, message(error));
      } else if (error instanceof BusinessIssue && BUSINESS_CODES.has(error.code)) {
        let evidence;
        try { assertPageSafe(); evidence = submissionEvidence(state); }
        catch (guardError) { pause(state, message(guardError)); return; }
        if (evidence) { pause(state, `${evidence}，业务异常不得跳过；请核对结果`); return; }
        state.lastBusinessIssue = { batchId: state.id, jobIndex: state.index, code: error.code };
        record(state, '待人工处理', message(error));
        await next(state);
      } else if (error instanceof PauseError) {
        if (state.stage === 'verify' && !/不同 ROMS|归属不明确/.test(message(error))) record(state, '需人工核实', `提交后出现异常：${message(error)}`);
        pause(state, message(error));
      } else if (state.stage === "verify") {
        record(state, "需人工核实", `提交后状态不明确：${message(error)}`);
        pause(state, message(error));
      } else {
        try { assertPageSafe(); const evidence = submissionEvidence(state); if (evidence) throw new PauseError(evidence); }
        catch (guardError) { pause(state, `${message(guardError)}；请核对页面，禁止跳过`); return; }
        record(state, "需核实", message(error));
        if (!state.jobs[state.index].issue) state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          pause(state, '连续 3 单未能完成，已暂停；请检查页面和处理记录');
        } else {
          await next(state);
        }
      }
    }
  }

  function render() {
    const panel = document.getElementById("znext-cainiao-panel");
    if (!panel) return;
    const state = loadState();
    const status = panel.querySelector("[data-status]");
    const choose = panel.querySelector("[data-choose]");
    const download = panel.querySelector("[data-download]");
    const stop = panel.querySelector("[data-stop]");
    const start = panel.querySelector('[data-start]');
    const preparing = state?.flow === 'prepare';
    const inputMode = panel.querySelector('[data-input-mode]');
    const open = sessionStorage.getItem(PANEL_KEY) === "true";
    panel.querySelector('[data-body]').hidden = !open;
    panel.querySelector('[data-toggle]').textContent = open ? "收起" : state?.active
      ? preparing ? '正在准备表格' : `销退 ${state.index + 1}/${state.jobs.length}`
      : state?.stage === "paused" ? "销退已暂停" : state?.stage === "stopped" ? "销退已停止" : state?.stage === "done" ? "销退已完成" : "销退助手";
    panel.querySelector('[data-toggle]').title = ['paused', 'stopped'].includes(state?.stage) ? displayReason(state.pauseReason) || '用户停止处理' : '';
    panel.style.width = open ? "320px" : "auto";
    panel.style.padding = open ? "14px" : "0";
    choose.hidden = !!state?.active;
    choose.textContent = inputMode.value === 'prepare' ? '选择拼多多售后表' : inputMode.value === 'three' ? '选择三类表格' : '选择售后表格';
    panel.querySelector('[data-mode]').hidden = !!state?.active;
    panel.querySelector('[data-prepare]').hidden = state?.stage !== 'prep_ready';
    panel.querySelector('[data-resume]').hidden = !preparing || !['paused', 'stopped'].includes(state?.stage);
    panel.querySelector('[data-import]').hidden = state?.stage !== 'prep_files';
    panel.querySelector('[data-redownload]').hidden = state?.stage !== 'prep_files' || !state?.exports?.length;
    download.hidden = !(state?.results?.length || (state?.mode === 'three' && state?.jobs?.length));
    download.textContent = state?.stage === 'ready' ? '下载匹配结果' : '下载处理记录';
    start.hidden = state?.stage !== 'ready' || !state?.jobs?.length;
    start.textContent = `开始创建 ${state?.jobs?.length || 0} 单`;
    stop.hidden = !state?.active;
    panel.querySelector('[data-takeover]').hidden = !['paused', 'stopped'].includes(state?.stage);
    panel.querySelector('[data-takeover]').disabled = busy;
    const skip = panel.querySelector('[data-skip]');
    skip.hidden = preparing || !['paused', 'stopped'].includes(state?.stage) || !state?.jobs?.[state.index];
    skip.disabled = busy;
    for (const selector of ['[data-choose]', '[data-import]', '[data-redownload]', '[data-prepare]', '[data-resume]', '[data-start]', '[data-input-mode]', '[data-dryrun]']) panel.querySelector(selector).disabled = busy;
    status.textContent = preparing
      ? ['paused', 'stopped'].includes(state.stage)
        ? `准备已暂停：${state.pauseReason || '用户停止'}。可点“继续准备”核对当前任务。${state.intent?.title ? `当前任务：${state.intent.title}。` : ''}续跑不会重复提交已记录的导出任务。`
        : `${state.prepMessage || '准备菜鸟表格'}${state.waitLabel ? `（${state.waitLabel}）` : ''}`
      : state?.active
      ? `正在处理 ${state.index + 1}/${state.jobs.length}：${state.jobs[state.index].aftersale}（${state.waitLabel || { lookup: "补查订单及既有销退", create: "填写销退", verify: "确认结果", cooldown: "等待下一单" }[state.stage] || "处理中"}）`
      : state?.stage === 'ready'
        ? state.mode === 'three'
          ? `匹配完成：售后 ${state.summary.total} 单；已建跳过 ${state.summary.existing} 单；无需建单 ${state.summary.excluded} 单；需处理 ${state.summary.issues} 单（其中疑似换运单 ${state.summary.waybillIssues || 0} 单）；待创建 ${state.summary.ready} 单（其中待补查 ${state.summary.lookup || 0} 单）。疑似换运单明细在匹配结果中，请核实并手动取消旧单后更新销退表。`
          : `读取到 ${state.jobs.length} 个售后单，点击开始后处理。`
      : state?.stage === "paused"
        ? `已暂停：${displayReason(state.pauseReason) || '请核对后台结果'}。可点“从最新进度继续”。当前单及后续进度已保留；提交过的只核对结果，不重提。也可下载处理记录。`
        : state?.stage === "stopped"
          ? "已停止处理，可下载已完成的记录。"
        : state?.stage === "done"
          ? state.dryRun ? '已核对第一单，未提交。记录已下载，正式处理请重新选择表格。'
            : `处理完毕：${batchOutcome(state).created} 已创建／${batchOutcome(state).deferred} 待人工处理／${batchOutcome(state).skipped} 人工跳过${batchOutcome(state).existing ? `／${batchOutcome(state).existing} 已建跳过` : ''}${batchOutcome(state).uncertain ? `／${batchOutcome(state).uncertain} 需核实` : ''}。仅统计本批任务；请下载处理记录，批次结束后处理待人工记录。`
          : "选拼多多售后表 → 准备菜鸟表格 → 选下载文件 → 匹配 → 开始创建。";
    if (state?.stage === 'prep_files') status.textContent += '\n本批导出已生成；点击图标仅为下载尝试。先检查浏览器实际文件，已保存可直接选择导入；未保存或被拦再按以下状态手动下载或仅允许菜鸟本站弹窗：\n' +
      (state.exports || []).map((task) => task.title + '（' + (task.downloadStatus || '下载结果未确认；等待实际文件核对') + '）').join('\n');
  }

  function panel() {
    if (document.getElementById("znext-cainiao-panel")) return;
    const box = document.createElement("div");
    box.id = "znext-cainiao-panel";
    box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:320px;padding:14px;background:#fff;color:#222;border:1px solid #aaa;border-radius:10px;box-shadow:0 4px 22px #0004;font:14px/1.5 sans-serif";
    box.innerHTML = `
      <button data-toggle type="button" style="cursor:pointer;border:0;border-radius:10px;background:#1769df;color:white;padding:9px 12px;font:14px sans-serif">销退助手</button>
      <div data-body>
      <div style="font-weight:bold;margin-top:8px;margin-bottom:8px">菜鸟销退单处理 1.6.7</div>
      <div data-status style="margin-bottom:10px;word-break:break-all"></div>
      <input data-file type="file" accept=".xlsx" multiple style="display:none">
      <input data-cainiao-file type="file" accept=".xlsx" multiple style="display:none">
      <div data-mode style="margin-bottom:8px">
      <label style="display:block;margin-bottom:8px">表格方式 <select data-input-mode>
        <option value="three">三张原始导出表</option>
        <option value="prepare">从拼多多表准备菜鸟文件</option><option value="single">已整理售后表（旧方式）</option>
      </select></label>
      <label style="display:block"><input data-dryrun type="checkbox"> 只核对一单，不提交</label>
      </div>
      <button data-choose type="button">选择三张表</button>
      <button data-prepare type="button">准备菜鸟表格</button>
      <button data-resume type="button">继续准备</button>
      <button data-import type="button">选择已下载的菜鸟文件</button>
      <button data-redownload type="button">重新下载本批文件</button>
      <button data-start type="button">开始创建</button>
      <button data-download type="button">下载处理记录</button>
      <button data-stop type="button">停止处理</button>
      </div>
    `;
    document.body.append(box);
    box.querySelector('[data-toggle]').addEventListener('click', () => {
      sessionStorage.setItem(PANEL_KEY, String(sessionStorage.getItem(PANEL_KEY) !== 'true'));
      render();
    });
    const takeover = document.createElement('button'); takeover.type = 'button'; takeover.dataset.takeover = ''; takeover.textContent = '从最新进度继续';
    box.querySelector('[data-body]').append(takeover);
    const skip = document.createElement('button'); skip.type = 'button'; skip.dataset.skip = ''; skip.textContent = '跳过当前单';
    box.querySelector('[data-body]').append(skip); skip.addEventListener('click', requestManualSkip);
    takeover.addEventListener('click', () => {
      const state = loadState();
      if (!state || state.active || busy || !['paused', 'stopped'].includes(state.stage)) return;
      if (!confirm('请先处理页面提示，并确认其他执行标签已停止。将从本批最新进度继续；提交不明只核实结果，导出只核对已有任务。现在继续？')) return;
      const prior = state.stage;
      try {
        if (!recoverSubmission(state)) state.stage = state.resumeStage || (state.lp ? 'create' : 'lookup');
      } catch (error) { pause(state, message(error)); return; }
      if (prior === 'done') return;
      state.active = true; state.runToken = crypto.randomUUID(); saveState(state); run(state, true);
    });
    const fileInput = box.querySelector("[data-file]");
    const inputMode = box.querySelector('[data-input-mode]');
    const existingBatch = loadState();
    if (existingBatch?.flow === 'prepare' && existingBatch.stage !== 'done') inputMode.value = 'prepare';
    else if (existingBatch?.mode && existingBatch.stage !== 'done') inputMode.value = existingBatch.mode;
    fileInput.multiple = inputMode.value === 'three';
    inputMode.addEventListener('change', () => {
      fileInput.multiple = inputMode.value === 'three';
      render();
    });
    box.querySelector("[data-choose]").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const files = [...(fileInput.files || [])];
      if (!files.length) return;
      if (loadState()?.active || busy) return;
      busy = true;
      const choose = box.querySelector('[data-choose]');
      const start = box.querySelector('[data-start]');
      const dryRun = box.querySelector('[data-dryrun]');
      const selectedMode = inputMode.value;
      choose.disabled = true;
      start.disabled = true;
      inputMode.disabled = true;
      dryRun.disabled = true;
      try {
        if (selectedMode !== 'three' && files.length !== 1) throw new Error('此方式只选一张拼多多售后表');
        const plan = selectedMode === 'prepare' ? preparePlan(await readTable(files[0])) : selectedMode === 'three' ? await readThreeFiles(files)
          : { jobs: await readJobs(files[0]), results: [], fileName: files[0].name, mode: 'single' };
        const state = selectedMode === 'prepare' ? plan : {
          ...plan, id: crypto.randomUUID(), index: 0, lp: '', stage: 'ready', active: false,
        };
        sessionStorage.setItem(PANEL_KEY, 'true');
        saveState(state);
      } catch (error) {
        alert(`表格读取失败：${message(error)}`);
      } finally {
        busy = false;
        fileInput.value = "";
        choose.disabled = false;
        start.disabled = false;
        inputMode.disabled = false;
        dryRun.disabled = false;
        render();
      }
    });
    box.querySelector('[data-prepare]').addEventListener('click', () => {
      const state = loadState();
      if (state?.stage !== 'prep_ready' || state.active || busy) return;
      state.startedAt = Date.now(); state.active = true; state.stage = 'prep_orders';
      state.runToken = crypto.randomUUID(); saveState(state); run(state);
    });
    box.querySelector('[data-resume]').addEventListener('click', () => {
      const state = loadState();
      if (state?.flow !== 'prepare' || state.active || busy || !state.resumeStage) return;
      state.active = true; state.stage = state.resumeStage; state.pauseReason = '';
      state.runToken = crypto.randomUUID(); saveState(state); run(state);
    });
    const cainiaoInput = box.querySelector('[data-cainiao-file]');
    box.querySelector('[data-redownload]').addEventListener('click', () => {
      const state = loadState();
      if (state?.stage !== 'prep_files' || state.active || busy || !state.exports?.length) return;
      state.active = true; state.stage = 'prep_redownload'; state.redownloadIndex = 0;
      state.runToken = crypto.randomUUID(); saveState(state); run(state);
    });
    box.querySelector('[data-import]').addEventListener('click', () => cainiaoInput.click());
    cainiaoInput.addEventListener('change', async () => {
      const state = loadState();
      if (state?.stage !== 'prep_files' || state.active || busy || !cainiaoInput.files.length) return;
      busy = true; render();
      const button = box.querySelector('[data-import]'); button.disabled = true;
      try {
        const imported = await importPrepared(state, [...cainiaoInput.files]);
        importIdentity(state); saveState(imported);
        inputMode.value = 'prepare'; fileInput.multiple = false; render();
      } catch (error) { alert(`文件核对未通过：${message(error)}`); }
      finally { busy = false; cainiaoInput.value = ''; button.disabled = false; render(); }
    });
    box.querySelector('[data-start]').addEventListener('click', () => {
      const state = loadState();
      if (!state || state.active || busy || state.stage !== 'ready' || !state.jobs.length) return;
      const dryRun = box.querySelector('[data-dryrun]').checked;
      if (!confirm(dryRun ? '将核对第一条待创建售后并填写页面，不提交。现在开始？'
        : `将正式创建 ${state.jobs.length} 个销退单，物流商统一选“其他”，地址使用页面默认信息；市或区缺失时选择当前上一级的首个有效项，并记录结果。${state.mode === 'three' ? '疑似换运单已列入匹配结果，请手动处理。匹配仅依据这次导出表和本标签页已确认创建记录。' : ''}现在开始？`)) return;
      state.dryRun = dryRun;
      state.jobLimit = dryRun ? 1 : state.jobs.length;
      state.active = true;
      state.runToken = crypto.randomUUID();
      setJobStage(state);
      sessionStorage.setItem(PANEL_KEY, 'false');
      saveState(state);
      run(state);
    });
    box.querySelector("[data-download]").addEventListener("click", () => {
      const state = loadState();
      if (state) csvDownload(state);
    });
    box.querySelector("[data-stop]").addEventListener("click", () => {
      const state = loadState();
      if (state) {
        if (state.stage === "verify") record(state, "需人工核实", "用户在提交后停止处理，请核对后台结果");
        state.active = false;
        state.resumeStage = state.stage;
        state.stage = "stopped";
        saveState(state);
      }
    });
    render();
  }

  if (location.hostname === "localhost") window.__cainiaoReturnsTest = { readJobs };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", panel, { once: true });
  else panel();
  const state = loadState();
  if (state?.active) setTimeout(() => run(state), 800);
})();
