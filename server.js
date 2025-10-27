// server.js
const WebSocket = require('ws');
const http = require('http');

// サーバーのポート
const PORT = 8080;

// HTTPサーバーを立てる
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket Server is running');
});

const wss = new WebSocket.Server({ server });

// 複数ルーム管理のためのグローバル状態
const sessions = {}; // { sessionId: { pcClient: ws, players: { P1: ws, P2: ws, ... }, isGameStarted: false } }

console.log(`Server started on http://localhost:${PORT}`);

// ユニークなセッションIDを生成するヘルパー関数
function generateSessionId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase(); // 4桁の英数字
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    // クライアントからのメッセージを受信
    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON received:', message);
            return;
        }

        const { type, role, sessionId, player, dx, dy } = data;

        // セッションID検証
        if (type !== 'register' && (!sessionId || !sessions[sessionId])) {
            ws.send(JSON.stringify({ type: 'error', message: '無効なルームIDまたはセッションが見つかりません。' }));
            return;
        }
        const session = sessions[sessionId];

        // 接続時の初期設定メッセージ
        if (type === 'register') {
            handleRegistration(ws, role, sessionId);
        }
        // スマホコントローラーからの移動入力
        else if (type === 'move' && session && session.isGameStarted) {
            handleMoveInput(session, player, dx, dy);
        }
        // PC画面からのゲーム開始通知
        else if (type === 'gameStart' && session && ws === session.pcClient) {
            session.isGameStarted = true;
            broadcastToControllers(session, { type: 'gameStatus', status: 'started' });
        }
        // PC画面からのゲーム終了通知
        else if (type === 'gameOver' && session && ws === session.pcClient) {
            session.isGameStarted = false;
            broadcastToControllers(session, { type: 'gameStatus', status: 'finished', winner: data.winner });
        }
    });

    // クライアント接続切断時の処理
    ws.on('close', () => {
        handleDisconnection(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket Error:', error);
    });
});

// 接続時のクライアント種別登録
function handleRegistration(ws, role, inputSessionId) {
    if (role === 'pc') {
        // 新しいセッションを作成
        const sessionId = generateSessionId();
        sessions[sessionId] = {
            pcClient: ws,
            players: {},
            isGameStarted: false
        };
        ws.role = 'pc';
        ws.sessionId = sessionId;
        console.log(`PC Client registered, new session created: ${sessionId}`);

        // PCクライアントにルームIDを送信
        ws.send(JSON.stringify({ type: 'sessionCreated', sessionId: sessionId, serverUrl: `ws://localhost:${PORT}` }));
    }
    else if (role === 'controller' && inputSessionId) {
        const session = sessions[inputSessionId];
        if (!session) {
            ws.send(JSON.stringify({ type: 'error', message: '指定されたルームIDは見つかりません。' }));
            ws.close();
            return;
        }

        // P1, P2,... の順にプレイヤーを割り当てる (最大2P固定)
        const playerKeys = Object.keys(session.players);
        let assignedPlayer = null;

        if (!session.players.P1) {
            assignedPlayer = 'P1';
        } else if (!session.players.P2) {
            assignedPlayer = 'P2';
        } else {
             // プレイヤー3以降の接続は拒否 (2Pレースゲームのため)
             ws.send(JSON.stringify({ type: 'error', message: 'このルームは既に満員です（2P専用）。' }));
             ws.close();
             return;
        }

        session.players[assignedPlayer] = ws;
        ws.role = 'controller';
        ws.sessionId = inputSessionId;
        ws.playerRole = assignedPlayer;

        ws.send(JSON.stringify({ type: 'assigned', player: assignedPlayer }));
        console.log(`Controller registered: ${assignedPlayer} in session ${inputSessionId}`);

        // PC画面にコントローラーの接続状況を通知
        updatePCStatus(session);
    }
}

// 移動入力の処理
function handleMoveInput(session, player, dx, dy) {
    // PCクライアントに移動コマンドを直接送信
    if (session.pcClient && session.pcClient.readyState === WebSocket.OPEN) {
        session.pcClient.send(JSON.stringify({ type: 'playerMove', player: player, dx: dx, dy: dy }));
    }
}

// 接続切断の処理
function handleDisconnection(ws) {
    const sessionId = ws.sessionId;
    const session = sessions[sessionId];
    if (!session) return;

    if (ws.role === 'pc') {
        console.log(`PC Client disconnected from session ${sessionId}. Closing session.`);
        // PCが切断されたら、セッション内の全てのコントローラーを切断し、セッションを破棄
        broadcastToControllers(session, { type: 'serverClosed', message: 'PCホストが切断されました。' });
        
        Object.values(session.players).forEach(playerWs => {
            if (playerWs.readyState === WebSocket.OPEN) {
                playerWs.close();
            }
        });
        delete sessions[sessionId];
    } 
    else if (ws.role === 'controller') {
        const playerRole = ws.playerRole;
        if (playerRole) {
            delete session.players[playerRole];
            console.log(`Controller ${playerRole} disconnected from session ${sessionId}.`);
            updatePCStatus(session); // PCに接続状況の変更を通知
        }
    }
}

// PCクライアントにコントローラーの接続状況を通知
function updatePCStatus(session) {
    if (session.pcClient && session.pcClient.readyState === WebSocket.OPEN) {
        const p1Connected = !!session.players.P1;
        const p2Connected = !!session.players.P2;

        const status = {
            type: 'controllerStatus',
            p1Connected: p1Connected,
            p2Connected: p2Connected
        };
        session.pcClient.send(JSON.stringify(status));
    }
}

// コントローラー全員にメッセージをブロードキャスト
function broadcastToControllers(session, message) {
    const jsonMessage = JSON.stringify(message);
    Object.values(session.players).forEach(playerWs => {
        if (playerWs.readyState === WebSocket.OPEN) {
            playerWs.send(jsonMessage);
        }
    });
}

// 接続維持のためのPing/Pong
const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) return ws.terminate();

        ws.isAlive = false;
        ws.ping();
    });
}, 30000); // 30秒ごとにPingを送信

server.listen(PORT);