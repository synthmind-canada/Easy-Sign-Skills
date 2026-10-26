// fetch 失败时 Node 真正抛出的错误形状（send 与 verify 两边的测试共用，不是测试文件本身）。
// 出处分三种，每一条都标着：
// - 实测：2026-10-25 在 macOS + Node 22.12.0 上真跑一次 fetch 抓下来的（外层 TypeError('fetch failed')，原因在 cause 上）
// - 推得：实测形状只换了 code / errno 一两个字段，换成的值写在那一条旁边
// - 合成：没有实测来源，只用来钉「认不出的形状一律算可能已发出」
// 工厂函数每次给一份新的错误对象。

const fetchFailed = (cause) => new TypeError('fetch failed', { cause });

// 与 Node 的 errno 异常同形：message 前缀是 syscall，code / errno / syscall 挂在对象上
function errno(message, fields) {
  return Object.assign(new Error(message), fields);
}

// Node 对多地址主机逐个建连、全部失败时抛的形状：AggregateError，自身带第一个地址的 code，message 为空
function aggregate(errors) {
  return Object.assign(new AggregateError(errors, ''), { code: errors[0].code });
}

const refused = (address) =>
  errno(`connect ECONNREFUSED ${address}:52991`, { code: 'ECONNREFUSED', errno: -61, syscall: 'connect', address, port: 52991 });
const denied = (address, local) =>
  errno(`connect EPERM ${address}:3999 - Local (${local})`, { code: 'EPERM', errno: -1, syscall: 'connect', address, port: 3999 });

/** [说明, 工厂, 期望的错误码]：连接建立之前就失败，请求没有离开这台电脑。 */
export const PRE_CONNECT = [
  // 实测：sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' 下 fetch https://www.easy-sign.ca（= Codex 沙箱的真实域名形态）；
  // 不在沙箱里 fetch https://x.invalid 也是这个形状
  ['DNS lookup refused in a sandbox (ENOTFOUND)', () => fetchFailed(errno('getaddrinfo ENOTFOUND www.easy-sign.ca', { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: 'www.easy-sign.ca' })), 'ENOTFOUND'],
  // 推得：上一条的形状，code / errno 换成 libuv 的 EAI_AGAIN（-3001，Linux 上 DNS 暂时不可用时的码）
  ['DNS temporarily unavailable (EAI_AGAIN)', () => fetchFailed(errno('getaddrinfo EAI_AGAIN www.easy-sign.ca', { code: 'EAI_AGAIN', errno: -3001, syscall: 'getaddrinfo', hostname: 'www.easy-sign.ca' })), 'EAI_AGAIN'],
  // 实测：fetch http://127.0.0.1:<关着的端口>
  ['connection refused (ECONNREFUSED)', () => fetchFailed(refused('127.0.0.1')), 'ECONNREFUSED'],
  // 实测：fetch http://localhost:<关着的端口>：::1 与 127.0.0.1 都被拒
  ['connection refused on every address of localhost', () => fetchFailed(aggregate([refused('::1'), refused('127.0.0.1')])), 'ECONNREFUSED'],
  // 实测：sandbox-exec（同上）下 fetch http://127.0.0.1:3999
  ['sandbox forbids connecting (EPERM)', () => fetchFailed(denied('127.0.0.1', '0.0.0.0:0')), 'EPERM'],
  // 实测：sandbox-exec（同上）下 fetch http://localhost:3999
  ['sandbox forbids connecting to every address (EPERM)', () => fetchFailed(aggregate([denied('::1', ':::0'), denied('127.0.0.1', '0.0.0.0:0')])), 'EPERM'],
  // 推得：上一条 EPERM 的形状，code / errno 换成 EACCES（-13）
  ['connecting not allowed (EACCES)', () => fetchFailed(errno('connect EACCES 127.0.0.1:3999 - Local (0.0.0.0:0)', { code: 'EACCES', errno: -13, syscall: 'connect', address: '127.0.0.1', port: 3999 })), 'EACCES'],
  // 实测：fetch http://192.168.2.247:81（本机局域网里没人用的地址）
  ['no route to the host (EHOSTUNREACH)', () => fetchFailed(errno('connect EHOSTUNREACH 192.168.2.247:81 - Local (192.168.2.119:53037)', { code: 'EHOSTUNREACH', errno: -65, syscall: 'connect', address: '192.168.2.247', port: 81 })), 'EHOSTUNREACH'],
  // 实测：fetch http://10.255.255.1:81
  ['no route to the network (ENETUNREACH)', () => fetchFailed(errno('connect ENETUNREACH 10.255.255.1:81', { code: 'ENETUNREACH', errno: -51, syscall: 'connect', address: '10.255.255.1', port: 81 })), 'ENETUNREACH'],
  // 实测：fetch http://8.8.8.8:81（包被丢弃，undici 10 秒建连超时）
  ['connect timed out (UND_ERR_CONNECT_TIMEOUT)', () => fetchFailed(Object.assign(new Error('Connect Timeout Error (attempted address: 8.8.8.8:81, timeout: 10000ms)'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' })), 'UND_ERR_CONNECT_TIMEOUT'],
];

/** [说明, 工厂]：连接已经建立过（或认不出），服务端可能已经收到了请求。 */
export const CONNECTED = [
  // 实测：本机 http 服务读完请求体后 socket.resetAndDestroy()；连上后立刻 destroy() 的 TCP 服务也是这个形状
  ['connection reset after the request (ECONNRESET)', () => fetchFailed(errno('read ECONNRESET', { code: 'ECONNRESET', errno: -54, syscall: 'read' }))],
  // 实测：本机 http 服务读完请求体后 socket.destroy()
  ['other side closed (UND_ERR_SOCKET)', () => fetchFailed(Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }))],
  // 合成：仿 node:http 客户端的 socket hang up（ECONNRESET、没有 syscall）；fetch 自己不报这个
  ['socket hang up', () => fetchFailed(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))],
  // 实测：本机 http 服务不回答，AbortSignal.timeout 到点：DOMException，没有 cause，code 是数字 23
  ['request timed out (AbortSignal)', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
  // 实测：fetch https://127.0.0.1:<明文 http 服务>
  ['TLS handshake failed', () => fetchFailed(Object.assign(new Error('807FD6E701000000:error:0A00010B:SSL routines:ssl3_get_record:wrong version number:../deps/openssl/openssl/ssl/record/ssl3_record.c:355:\n'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER', library: 'SSL routines', reason: 'wrong version number' }))],
  // 推得：上面 read ECONNRESET 的形状，code / errno 换成 Linux 的 EHOSTUNREACH（-113）—— Linux 上已建立的连接
  // 遇到 ICMP 主机不可达时在 read 上报这个码。码在建连前清单里，syscall 说明连接建立过
  ['host unreachable on an open connection (read EHOSTUNREACH)', () => fetchFailed(errno('read EHOSTUNREACH', { code: 'EHOSTUNREACH', errno: -113, syscall: 'read' }))],
  // 推得：localhost 的 AggregateError，第二个地址换成 Node 逐个建连时的单地址超时（connect ETIMEDOUT，macOS errno -60；
  // Node 的 net.js internalConnectMultipleTimeout 就是这样记的）。
  // ETIMEDOUT 不在清单里：每一个地址都得是清单里的码才算连不上
  ['refused on one address, a code not on the list on the other', () => fetchFailed(aggregate([refused('::1'), errno('connect ETIMEDOUT 127.0.0.1:52991', { code: 'ETIMEDOUT', errno: -60, syscall: 'connect', address: '127.0.0.1', port: 52991 })]))],
  // 合成：只有外层、没有 cause
  ['an error with no code', () => new TypeError('fetch failed')],
  // 实测：fetch http://localhost:1（fetch 自己拒绝的端口，cause 没有 code）
  ['a bad port, refused by fetch itself with no code', () => fetchFailed(new Error('bad port'))],
];
