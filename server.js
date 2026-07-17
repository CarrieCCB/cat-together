/**
 * ============================================================================
 *  线上小猫 · 服务端 (server.js)
 *  技术栈：Node.js + Express + Socket.io
 *
 *  功能概述：
 *   - 固定两人协作养一只二次元橘猫（用户A🟢 / 用户B🔵）
 *   - 最多 2 人同时在线，第三人访问提示“已满员”并断开
 *   - 同一设备刷新保持原身份（前端 localStorage 记住 clientId）
 *   - 猫咪 4 项属性（饱腹/快乐/清洁/精力）服务端每 5 秒自动衰减
 *   - 5 个成长阶段，根据“总互动次数”自动升级并广播庆祝事件
 *   - 每个用户每个操作独立 8 秒冷却
 *   - 喂养记录（最多 100 条，含成长里程碑）
 *   - 状态每 30 秒持久化到 data.json，重启自动恢复
 *   - 所有变化通过 socket.io 广播给全部在线用户
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 托管前端静态资源（public 目录）
app.use(express.static(path.join(__dirname, 'public')));

// 数据持久化文件路径
const DATA_FILE = path.join(__dirname, 'data.json');

// ============================================================================
//  成长阶段配置
//  threshold：进入该阶段所需的最小总互动次数
//  scale：前端 transform: scale() 体型缩放
//  initValue：该阶段“初始属性值”（首次创建 & 升级时作为属性下限保底）
// ============================================================================
const STAGES = [
  { name: '幼猫期', threshold: 0,   scale: 0.5, initValue: 50, food: { name: '猫奶', icon: '🍼' } },
  { name: '小猫期', threshold: 10,  scale: 0.7, initValue: 55, food: { name: '猫粮', icon: '🥣' } },
  { name: '少年期', threshold: 30,  scale: 0.9, initValue: 60, food: { name: '猫罐头', icon: '🥫' } },
  { name: '成猫期', threshold: 60,  scale: 1.1, initValue: 65, food: { name: '三文鱼', icon: '🐟' } },
  { name: '大猫期', threshold: 100, scale: 1.3, initValue: 75, food: { name: '海鲜大餐', icon: '🦐' } }
];

// 根据总互动次数计算当前阶段下标（0~4）
function getStageIndex(total) {
  let idx = 0;
  for (let i = 0; i < STAGES.length; i++) {
    if (total >= STAGES[i].threshold) idx = i;
  }
  return idx;
}

// 计算“距离下一阶段还需多少次互动”，已满级返回 null
function getNextStageInfo(total) {
  const idx = getStageIndex(total);
  if (idx >= STAGES.length - 1) {
    return { isMax: true, remain: 0, current: STAGES[idx].threshold, next: null };
  }
  const next = STAGES[idx + 1];
  return {
    isMax: false,
    remain: next.threshold - total,
    current: STAGES[idx].threshold,
    next: next.threshold
  };
}

// ============================================================================
//  全局状态对象
// ============================================================================
let state = null;

// 初始化一份全新的猫咪数据
function createInitialState() {
  return {
    // 猫咪 4 项属性（0~100）
    stats: { fullness: 50, happiness: 50, cleanliness: 50, energy: 50 },
    // 总互动次数
    totalInteractions: 0,
    // 今日互动次数 + 记录日期（跨天自动清零）
    todayInteractions: 0,
    todayDate: todayStr(),
    // 当前成长阶段下标
    stageIndex: 0,
    // 喂养记录（最多 100 条，最新在前）
    records: []
  };
}

// 返回本地日期字符串 YYYY-MM-DD
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 返回 HH:MM:SS 时间字符串（用于记录展示）
function timeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// 从磁盘读取状态，不存在或损坏则初始化
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      // 兜底补齐字段，兼容旧数据
      state = Object.assign(createInitialState(), parsed);
      state.stats = Object.assign({ fullness: 50, happiness: 50, cleanliness: 50, energy: 50 }, parsed.stats || {});
      if (!Array.isArray(state.records)) state.records = [];
      // 校正阶段（防止数据被外部篡改）
      state.stageIndex = getStageIndex(state.totalInteractions);
      // 跨天清零今日互动
      if (state.todayDate !== todayStr()) {
        state.todayDate = todayStr();
        state.todayInteractions = 0;
      }
      console.log('[data] 已从 data.json 恢复猫咪状态');
      return;
    }
  } catch (err) {
    console.error('[data] 读取 data.json 失败，重新初始化：', err.message);
  }
  state = createInitialState();
  console.log('[data] 初始化全新猫咪');
}

// 将当前状态写入磁盘
function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[data] 写入 data.json 失败：', err.message);
  }
}

// ============================================================================
//  在线用户管理
//  两个固定槽位 A / B，由前 2 个不同的 clientId 认领：
//   - 已知 clientId（匹配 A 或 B）→ 复用原身份（刷新/重连保持不变）
//   - 新 clientId：优先占用空槽位；若两槽位都被占但有人离线，则接管离线槽位
//   - 两人都在线时，第三人 → 已满员并断开
// ============================================================================
const slots = {
  A: { clientId: null, socketId: null, online: false },
  B: { clientId: null, socketId: null, online: false }
};

// 属性范围钳制到 0~100
function clamp(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

// 是否处于睡觉状态（精力 < 20 闭眼睡觉，衰减减半）
function isSleeping() {
  return state.stats.energy < 20;
}

// 计算当前表情：sleep / sad / happy / normal
function getMood() {
  if (isSleeping()) return 'sleep';
  const s = state.stats;
  const vals = [s.fullness, s.happiness, s.cleanliness, s.energy];
  if (vals.some(v => v < 20)) return 'sad';
  if (vals.every(v => v > 70)) return 'happy';
  return 'normal';
}

// 组装广播给前端的完整快照
function buildSnapshot() {
  const stage = STAGES[state.stageIndex];
  const nextInfo = getNextStageInfo(state.totalInteractions);
  return {
    stats: state.stats,
    totalInteractions: state.totalInteractions,
    todayInteractions: state.todayInteractions,
    stageIndex: state.stageIndex,
    stageName: stage.name,
    scale: stage.scale,
    food: stage.food,
    mood: getMood(),
    sleeping: isSleeping(),
    nextInfo,
    records: state.records,
    online: { A: slots.A.online, B: slots.B.online }
  };
}

// 向所有在线用户广播最新状态
function broadcastState() {
  io.emit('state', buildSnapshot());
}

// 向记录列表新增一条记录（最多保留 100 条）
function addRecord(record) {
  state.records.unshift(record);
  if (state.records.length > 100) state.records.length = 100;
}

// ============================================================================
//  交互操作定义
//  每个操作对属性的增减；精力都会消耗
// ============================================================================
const ACTIONS = {
  feed:  { label: '喂食', effects: { fullness: +20, energy: -5 } },
  play:  { label: '逗猫', effects: { happiness: +15, energy: -10 } },
  clean: { label: '洗澡', effects: { cleanliness: +25, energy: -5 } },
  pet:   { label: '抚摸', effects: { happiness: +10, cleanliness: +5, energy: -2 } }
};

// 冷却时间（毫秒），每个用户每个操作独立计时
const COOLDOWN_MS = 8000;
// cooldowns[role][action] = 该操作可再次使用的时间戳
const cooldowns = { A: {}, B: {} };

// 根据操作与阶段生成生动的浮动反馈文案
function buildFeedback(role, actionKey) {
  const stage = STAGES[state.stageIndex];
  const food = stage.food;
  const map = {
    feed:  `${role} 喂了${food.name}，橘猫开心地打滚！`,
    play:  `${role} 陪橘猫玩耍，它兴奋地跳了起来！`,
    clean: `${role} 给橘猫洗了个香香澡，毛茸茸的～`,
    pet:   `${role} 温柔地抚摸橘猫，它眯眼蹭了蹭手心`
  };
  return map[actionKey] || `${role} 与橘猫互动了一下`;
}

// ============================================================================
//  升级检测：互动次数变化后检查是否跨越阶段阈值
//  升级则：更新阶段、属性保底提升到该阶段初始值、记录里程碑、广播庆祝事件
// ============================================================================
function checkLevelUp() {
  const newIndex = getStageIndex(state.totalInteractions);
  if (newIndex > state.stageIndex) {
    // 可能一次跨多级（极端情况），逐级处理里程碑
    while (state.stageIndex < newIndex) {
      state.stageIndex++;
      const stage = STAGES[state.stageIndex];
      // 升级奖励：所有属性保底提升到该阶段初始值
      Object.keys(state.stats).forEach(k => {
        state.stats[k] = clamp(Math.max(state.stats[k], stage.initValue));
      });
      // 里程碑记录（金色加粗）
      addRecord({
        time: timeStr(),
        type: 'milestone',
        text: `🎉 小猫长大了！进入${stage.name}`
      });
      // 广播升级庆祝事件（前端弹全屏彩带/烟花）
      io.emit('levelup', {
        stageIndex: state.stageIndex,
        stageName: stage.name,
        scale: stage.scale
      });
      console.log(`[levelup] 升级至 ${stage.name}`);
    }
    return true;
  }
  return false;
}

// ============================================================================
//  Socket.io 连接处理
// ============================================================================
io.on('connection', (socket) => {
  // 客户端携带 localStorage 中的 clientId 请求加入
  socket.on('join', (payload) => {
    const clientId = (payload && payload.clientId) ? String(payload.clientId) : null;
    if (!clientId) {
      socket.emit('rejected', { reason: 'invalid', message: '缺少设备标识' });
      return;
    }

    let role = null;

    // 1) 已知 clientId → 复用原身份（刷新/重连保持不变）
    if (slots.A.clientId === clientId) role = 'A';
    else if (slots.B.clientId === clientId) role = 'B';

    // 2) 新设备：占用空槽位
    if (!role) {
      if (!slots.A.clientId) role = 'A';
      else if (!slots.B.clientId) role = 'B';
    }

    // 3) 两槽位都被占：若有人离线则接管离线槽位
    if (!role) {
      if (!slots.A.online) role = 'A';
      else if (!slots.B.online) role = 'B';
    }

    // 4) 两人都在线 → 已满员
    if (!role) {
      socket.emit('full', { message: '小猫之家已满员（最多 2 人同时在线），请稍后再来～' });
      // 稍作延迟再断开，确保前端能收到提示
      setTimeout(() => socket.disconnect(true), 300);
      console.log('[join] 第三人访问被拒绝：已满员');
      return;
    }

    // 认领槽位
    slots[role].clientId = clientId;
    slots[role].socketId = socket.id;
    slots[role].online = true;
    socket.data.role = role;
    socket.data.clientId = clientId;

    // 告知本人身份
    socket.emit('assigned', { role, snapshot: buildSnapshot() });
    // 广播上线通知 & 最新在线状态
    io.emit('presence', { role, online: true, message: `用户${role} 上线啦` });
    broadcastState();
    console.log(`[join] 用户${role} 上线 (clientId=${clientId.slice(0, 8)}…)`);
  });

  // 处理交互操作
  socket.on('action', (payload) => {
    const role = socket.data.role;
    if (!role) return; // 未分配身份，忽略
    const actionKey = payload && payload.action;
    const action = ACTIONS[actionKey];
    if (!action) return;

    const now = Date.now();
    const readyAt = cooldowns[role][actionKey] || 0;
    // 冷却中：拒绝并返回剩余时间
    if (now < readyAt) {
      socket.emit('cooldown', { action: actionKey, remainMs: readyAt - now });
      return;
    }
    // 设置冷却
    cooldowns[role][actionKey] = now + COOLDOWN_MS;

    // 应用属性变化
    Object.keys(action.effects).forEach(k => {
      state.stats[k] = clamp(state.stats[k] + action.effects[k]);
    });

    // 互动次数 +1（总计 & 今日）
    if (state.todayDate !== todayStr()) {
      state.todayDate = todayStr();
      state.todayInteractions = 0;
    }
    state.totalInteractions += 1;
    state.todayInteractions += 1;

    // 记录本次操作
    const stage = STAGES[state.stageIndex];
    const detail = actionKey === 'feed' ? stage.food.name : action.label;
    addRecord({
      time: timeStr(),
      type: role, // 'A' 绿色 / 'B' 蓝色
      role,
      action: action.label,
      detail: actionKey === 'feed' ? stage.food.name : ''
    });

    // 广播浮动反馈 + 猫咪动画（吃/跳/蹭等）
    io.emit('feedback', {
      role,
      action: actionKey,
      text: buildFeedback(role, actionKey),
      food: stage.food
    });

    // 检查升级（会在内部广播 levelup + 里程碑记录）
    checkLevelUp();

    // 广播最新完整状态 + 冷却时间给操作者
    socket.emit('cooldown', { action: actionKey, remainMs: COOLDOWN_MS });
    broadcastState();
  });

  // 断开连接：标记离线，广播通知
  socket.on('disconnect', () => {
    const role = socket.data.role;
    if (role && slots[role].socketId === socket.id) {
      slots[role].online = false;
      slots[role].socketId = null;
      io.emit('presence', { role, online: false, message: `用户${role} 已离线` });
      broadcastState();
      console.log(`[disconnect] 用户${role} 离线`);
    }
  });
});

// ============================================================================
//  定时任务
// ============================================================================

// 1) 每 5 秒自动衰减属性（睡觉时衰减减半）
setInterval(() => {
  if (!state) return;
  const half = isSleeping(); // 精力 < 20 时衰减减半
  const base = { fullness: -2, happiness: -1, cleanliness: -1, energy: -2 };
  Object.keys(base).forEach(k => {
    const delta = half ? base[k] / 2 : base[k];
    state.stats[k] = clamp(state.stats[k] + delta);
  });
  broadcastState();
}, 5000);

// 2) 每 30 秒持久化状态到 data.json
setInterval(() => {
  if (state) saveState();
}, 30000);

// 进程退出前保存一次，避免丢数据
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    console.log(`\n[exit] 收到 ${sig}，保存状态后退出`);
    if (state) saveState();
    process.exit(0);
  });
});

// ============================================================================
//  启动服务
//  Render 要求：端口用 process.env.PORT，地址用 0.0.0.0
// ============================================================================
loadState();
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🐱 线上小猫已启动：http://0.0.0.0:${PORT}`);
});
