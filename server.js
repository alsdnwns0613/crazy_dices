// 필요한 모듈들을 불러옵니다.
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

// Express 앱을 생성합니다.
const app = express();
// HTTP 서버를 생성합니다. Express 앱을 이 서버에 연결합니다.
const server = http.createServer(app);
// Socket.IO 서버를 생성하고, HTTP 서버에 연결합니다.
// CORS 설정을 통해 다른 도메인(클라이언트)에서 접속할 수 있도록 허용합니다.
const io = new socketIo.Server(server, {
    cors: {
        origin: "*", // 모든 도메인에서의 접속을 허용합니다 (개발 단계에서만 사용, 실제 서비스 시에는 특정 도메인으로 제한 권장)
        methods: ["GET", "POST"]
    }
});

// --- 서버 내 게임 상태 관리 ---
// 현재 활성화된 방 목록. 키: roomId, 값: { name, hostPlayerId, players: [], status }
const rooms = {}; // players는 playerId 배열
// 연결된 모든 플레이어 정보. 키: playerId, 값: { name, currentRoomId, role, status, position, color, inventory, currentSocketId }
// player 객체에 lastDiceRollPosition 추가하여 고정의 주사위 사용 시 활용
const playersData = {}; // playerId 기반
// socket.id와 playerId 매핑 (연결 끊겼을 때 playerId 찾기 위함)
const socketIdMap = {}; // 키: socket.id, 값: playerId

// 플레이어별 재접속 대기 타이머 (playerId -> timeoutId)
const reconnectionTimeouts = {}; 
const RECONNECT_TIMEOUT_MS = 30 * 1000; // 30초 재접속 대기

// --- 정적 파일(HTML, CSS, JS) 서빙 설정 ---
app.use(express.static(process.cwd()));

// --- 헬퍼 함수: 플레이어가 속한 방 ID 찾기 ---
function getPlayerRoomId(playerId) {
    return playersData[playerId] ? playersData[playerId].currentRoomId : null;
}

// --- 헬퍼 함수: 방 목록 전체 업데이트 클라이언트에게 전송 ---
function emitRoomListUpdate() {
    const simplifiedRooms = Object.values(rooms).map(room => ({
        id: room.id,
        name: room.name,
        playersCount: room.players.length,
        maxPlayers: room.maxPlayers,
        status: room.status
    }));
    io.emit('room_list_update', simplifiedRooms); // 모든 클라이언트에 브로드캐스트
}

// --- 헬퍼 함수: 특정 방의 플레이어 목록 업데이트 전송 ---
// 이 함수는 이제 해당 방에 있는 각 플레이어의 currentSocketId로 직접 전송합니다.
function emitPlayerListUpdate(roomId) {
    if (!rooms[roomId]) return;
    const roomPlayers = rooms[roomId].players.map(playerId => {
        const playerInfo = playersData[playerId];
        if (!playerInfo) return null; 
        return {
            id: playerId, 
            name: playerInfo.name,
            status: playerInfo.status,
            role: playerInfo.role,
            position: playerInfo.position,
            color: playerInfo.color,
            inventory: playerInfo.inventory 
        };
    }).filter(p => p !== null); 

    // 방 안에 있는 각 플레이어에게 개별적으로 업데이트를 보냅니다.
    rooms[roomId].players.forEach(playerId => {
        const player = playersData[playerId];
        if (player && player.currentSocketId) {
            io.to(player.currentSocketId).emit('player_list_update', roomPlayers);
        }
    });
}

// --- 헬퍼 함수: 특정 방의 플레이어 객체들을 배열로 반환 ---
function getPlayersInRoom(roomId) {
    if (!rooms[roomId]) return [];
    return rooms[roomId].players.map(playerId => playersData[playerId]).filter(p => p !== undefined);
}


// --- 플레이어 토큰 색상 팔레트 ---
const playerColors = [
    '#FF5733', '#33FF57', '#3357FF', '#FF33FF', '#33FFFF',
    '#FF8333', '#2e5614ff', '#8333FF', '#FF3383', '#4b33ffff'
];
// 사용 가능한 색상 (서버 시작 시 초기화)
let availablePlayerColors = [...playerColors]; 

// --- 헬퍼 함수: 사용 가능한 플레이어 색상 가져오기 (겹치지 않게) ---
function getPlayerColor() {
    if (availablePlayerColors.length === 0) {
        // 모든 색상이 소진되면 다시 채워넣음. 실제 게임에서는 더 정교한 색상 관리 필요.
        availablePlayerColors = [...playerColors];
        console.warn("플레이어 색상 팔레트 재충전. 색상 중복 가능성이 있습니다.");
    }
    const colorIndex = Math.floor(Math.random() * availablePlayerColors.length);
    const color = availablePlayerColors[colorIndex];
    availablePlayerColors.splice(colorIndex, 1); // 사용한 색상 제거
    return color;
}

// 보드 칸 개수 (시작 칸 포함, 0~47)
const TOTAL_BOARD_CELLS = 48;
const JAIL_CELL_INDEX = 24; // 무인도 칸 고정: 12번째 칸 (오른쪽 위 모서리)

// --- 보드 칸 이벤트 정의 (타입: 'get_dice', 'move_effect', 'special_event') ---
const boardEventTypes = [
    { type: 'get_dice', value: '플러스의 주사위', weight: 9 },
    { type: 'get_dice', value: '마이너스의 주사위', weight: 9 },
    { type: 'get_dice', value: '보호의 주사위', weight: 9 },
    { type: 'get_dice', value: '저주의 주사위', weight: 9 },    
    { type: 'get_dice', value: '확률의 주사위', weight: 9 },
    { type: 'get_dice', value: '무작위의 주사위', weight: 9 },
    { type: 'get_dice', value: '벌칙의 주사위', weight: 9 },
    { type: 'get_dice', value: '저장의 주사위', weight: 7 }, // 자주 나와서 불편하다는 피드백 있었으니 좀 줄임
    { type: 'get_dice', value: '고정의 주사위', weight: 7 }, // 자주 나와서 불편하다는 피드백 있었으니 좀 줄임
    { type: 'get_dice', value: '강화의 주사위', weight: 9 }, // 자주 나와서 불편하다는 피드백 있었으니 좀 줄임
    // 일반 이벤트
    { type: 'event', name: '두 칸 뒤로 가기', weight: 4, effect: { type: 'move_back', value: 2 } },
    { type: 'event', name: '원하는 주사위 받기', weight: 3, effect: { type: 'get_any_dice' } }, // 이 로직은 나중에 구현 필요
    { type: 'event', name: '빈 칸', weight: 25, effect: { type: 'empty' } }, // 빈 칸은 가장 높은 비중
];

// --- 강화 주사위 정의 (get_dice) ---
const enhancedDiceTypes = [
    { type: 'get_dice', value: '강화 운명의 주사위' },
    { type: 'get_dice', value: '강화 플러스의 주사위' },
    { type: 'get_dice', value: '강화 마이너스의 주사위' },
    { type: 'get_dice', value: '강화 저주의 주사위' },
    { type: 'get_dice', value: '강화 보호의 주사위' },
    { type: 'get_dice', value: '강화 무작위의 주사위' },
    { type: 'get_dice', value: '강화 벌칙의 주사위' },
    { type: 'get_dice', value: '강화 확률의 주사위' },
    { type: 'get_dice', value: '강화 고정의 주사위' },
    { type: 'get_dice', value: '강화 저장의 주사위' },
];


// --- 헬퍼 함수: 가중치에 따라 무작위 이벤트 선택 ---
function getRandomWeightedEvent(events) {
    const totalWeight = events.reduce((sum, event) => sum + event.weight, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < events.length; i++) {
        if (random < events[i].weight) {
            return events[i];
        }
        random -= events[i].weight;
    }
    return events[0]; // Fallback
}

// --- 헬퍼 함수: 플레이어 위치 업데이트 및 승리 판정 통합 ---
function updatePlayerPositionAndCheckWin(roomId, player, oldPosition, roll, isEventMove = false) {
    const room = rooms[roomId];
    
    // 무인도 상태일 경우 이동 불가 (오직 roll_dice에만 해당, 이벤트 이동은 강제 이동이므로 허용)
    // (player.statusEffects.jail && !isEventMove) 부분은 이미 roll_dice 쪽에 구현되어 있음
    // -> 이 함수에 들어왔다는 건 이미 이동이 가능하다는 뜻

    const potentialNewPosition = oldPosition + roll;
    let newPosition = potentialNewPosition % TOTAL_BOARD_CELLS;
    
    // 바퀴 수(laps) 업데이트
    if (roll > 0 && potentialNewPosition >= TOTAL_BOARD_CELLS && oldPosition < TOTAL_BOARD_CELLS) { // oldPosition < TOTAL_BOARD_CELLS는 처음 시작할때 0 > 48 이 되는걸 방지
         player.laps++;
    } else if (roll < 0 && newPosition < oldPosition && potentialNewPosition < 0) { // 뒤로 이동해서 바퀴를 역으로 넘을 경우 (드물지만)
        player.laps--; // 바퀴 수 감소
        if (player.laps < 0) player.laps = 0; // 음수 방지
    }
    
    player.position = newPosition; // 최종 위치 반영
    player.lastDiceRollPosition = oldPosition; // 현재 이동 전 위치 저장 (고정의 주사위 위함)


    // 모든 클라이언트에 브로드캐스트
    io.to(roomId).emit('dice_roll_result', { // roomId에 있는 클라이언트에만 보냄
        playerId: player.id,
        playerName: player.name,
        roll: roll,
        oldPosition: oldPosition,
        newPosition: newPosition,
        isEventMove: isEventMove
    });

    // 승리 조건: 한 바퀴 이상 돌기만 하면 승리 (0번 칸을 지나거나 정확히 0번에 도착)
    const isWinner = player.laps >= 1; 
    
    return { newPosition: newPosition, isWin: isWinner };
}


// --- 헬퍼 함수: 칸 이벤트 실행 로직 ---
function executeBoardEvent(roomId, player) {
    const room = rooms[roomId];
    if (!room || !player) return;

    // 0번 칸은 시작 칸이므로 이벤트 없음
    if (player.position === 0) {
        io.to(roomId).emit('player_landed_on_event', { // roomId에 있는 클라이언트에만 보냄
            playerId: player.id,
            playerName: player.name,
            cellIndex: player.position,
            eventName: '시작 지점',
            message: `${player.name}님이 시작 지점에 도착했습니다.`
        });
        return;
    } 


    // 무인도 칸 고정 처리 (이벤트 발동은 여기 안에서)
    if (player.position === JAIL_CELL_INDEX) {
        if(player.isProtect != true){
            // 이미 무인도에 있거나, 무인도 칸으로 이동한 경우에만 스킵 턴 부여
            if (!player.statusEffects.jail) { 
                player.statusEffects.jail = { skipTurns: 2, currentSkip: 0 };
                io.to(roomId).emit('player_landed_on_event', { // roomId에 있는 클라이언트에만 보냄
                    playerId: player.id,
                    playerName: player.name,
                    cellIndex: player.position,
                    eventName: '무인도',
                    message: `${player.name}님이 무인도에 도착했습니다! 다음 ${player.statusEffects.jail.skipTurns}턴을 쉽니다.`
                });
                emitPlayerListUpdate(roomId); // 상태 업데이트
            } else {
                io.to(roomId).emit('player_landed_on_event', { // roomId에 있는 클라이언트에만 보냄
                    playerId: player.id,
                    playerName: player.name,
                    cellIndex: player.position,
                    eventName: '무인도',
                    message: `${player.name}님은 여전히 무인도에 있습니다. 남은 턴: ${player.statusEffects.jail.skipTurns}`
                });
            }
        }
        else {
            io.to(roomId).emit('server_message', `${player.name}님이 보호의 주사위 사용에 성공했습니다`);
            player.isProtect = false;
        }

        return;
    }

    // 일반 칸 이벤트 ( assignedBoardEvents의 0번 인덱스는 보드 칸 1번에 매핑됨 )
    const event = room.assignedBoardEvents[player.position - 1]; 
    
    // --- 수정 시작: event가 유효하지 않을 때 처리 ---
    if (!event) { // assignedEvents 배열에 해당 인덱스에 이벤트가 없는 경우
        io.to(roomId).emit('player_landed_on_event', {
            playerId: player.id,
            playerName: player.name,
            cellIndex: player.position,
            eventName: '빈 칸 (이벤트 없음)',
            message: `${player.name}님이 빈 칸에 도착했습니다.`
        });
        return; 
    }
    
    // 빈 칸 이벤트 처리
    if (event.type === 'event' && event.effect && event.effect.type === 'empty') {
         io.to(roomId).emit('player_landed_on_event', {
            playerId: player.id,
            playerName: player.name,
            cellIndex: player.position,
            eventName: '빈 칸',
            message: `${player.name}님이 빈 칸에 도착했습니다.`
        });
        return; 
    }

    // 이벤트 로깅 (빈 칸 제외한 일반 이벤트)
    io.to(roomId).emit('player_landed_on_event', { // roomId에 있는 클라이언트에만 보냄
        playerId: player.id,
        playerName: player.name,
        cellIndex: player.position,
        eventName: event.value || event.name,
        message: `${player.name}님이 '${event.value || event.name}' 칸에 도착했습니다.`
    });
    
    if (event.type === 'get_dice') {
        player.inventory.push(event.value); // 인벤토리에 주사위 추가
        io.to(roomId).emit('server_message', `${player.name}님이 '${event.value}'을(를) 획득했습니다!`); // roomId에 있는 클라이언트에만 보냄
        emitPlayerListUpdate(roomId); // 인벤토리 업데이트
    } 
    else if (event.type === 'event' && event.effect) {
        if (event.effect.type === 'move_back') {
            const oldPlayerPos = player.position; // 이벤트 이동 전 위치
            const currentRollEffect = -event.effect.value; // 음수 롤
            const { newPosition, isWin } = updatePlayerPositionAndCheckWin(roomId, player, oldPlayerPos, currentRollEffect, true); // 이벤트 이동임을 명시
            
            io.to(roomId).emit('server_message', `${player.name}님이 ${event.effect.value}칸 뒤로 이동했습니다.`); // roomId에 있는 클라이언트에만 보냄
            // isWin 체크
            if (isWin) {
                // 승리 로직 실행
                io.to(roomId).emit('game_ended', { winnerId: player.id, winnerName: player.name }); // roomId에 있는 클라이언트에만 보냄
                // 게임 종료 후 방 상태 및 플레이어 상태 초기화
                resetRoomAndPlayersForNewGame(roomId);
            } else {
                // 이동 후 칸에 또 다른 이벤트가 있다면 실행 (꼬리 물기)
                executeBoardEvent(roomId, player);
            }

        } 

    else if (event.effect.type === 'get_any_dice') {
        // 원하는 주사위 받기: 클라이언트에게 선택지를 주고 선택 결과를 받음
        // const availableDiceNames = boardEventTypes.filter(e => e.type === 'get_dice').map(e => e.value);
        // io.to(player.currentSocketId).emit('request_dice_selection', { // io.to(player.currentSocketId)
        //     playerId: player.id,
        //     availableDice: availableDiceNames,
        //     message: "원하는 주사위를 선택해주세요!"
        // });
        // 서버는 선택 결과를 기다려야 함 (select_dice_choice 이벤트)

        io.to(roomId).emit('server_message', `미구현: 원하는 주사위 받기 칸은 아직 개발되지 않았습니다.`);
    }
}
}



// --- 헬퍼 함수: 게임 종료 후 방 및 플레이어 초기화 ---
function resetRoomAndPlayersForNewGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.status = 'waiting'; // 방 상태를 다시 대기 중으로
    room.currentTurnIndex = 0; // 턴 정보 초기화 (방장이 첫 턴 가지도록 0)
    room.assignedBoardEvents = []; // 보드 이벤트 초기화 (새 게임 시 다시 배정)
    
    room.players.forEach(pId => { // 방 안의 모든 플레이어 초기화

        // --- 수정 시작: 방장 상태 유지 ---
        if (playersData[pId].role === 'host') {
            playersData[pId].status = '준비'; // 방장은 '준비' 상태로 유지
        } else {
            playersData[pId].status = '대기'; // 일반 플레이어는 '대기' 상태로
        }
        // --- 수정 끝 ---

        //playersData[pId].status = '대기'; // 모두 '대기' 상태로
        playersData[pId].position = 0; // 시작 위치로 이동
        playersData[pId].laps = 0; // 바퀴 수 초기화
        playersData[pId].inventory = []; // 게임 종료 후 인벤토리 비어있어야 함
        playersData[pId].statusEffects = {}; // 상태 효과 초기화 (무인도 등)
        playersData[pId].lastDiceRollPosition = 0; // 마지막 주사위 굴림 위치 초기화
        playersData[pId].isSavingActive = false;
        playersData[pId].savingStack = 0;
        playersData[pId].e_isSavingActive = false;
        playersData[pId].e_savingStack = 0;
        playersData[pId].isProtect = false;
    });
    emitPlayerListUpdate(roomId); // 초기화된 플레이어 목록 전송
    emitRoomListUpdate(); // 방 상태 변경 (waiting) 알림
}


// --- Socket.IO 연결 이벤트 처리 ---
io.on('connection', (socket) => {
    console.log(`[서버 로그] 새로운 소켓 연결: ${socket.id}`);
    
    // --- 클라이언트 요청: 초기 플레이어 정보 설정 (로그인 시/재접속 시) ---
    // 클라이언트가 자신의 playerId와 name을 서버에 알려주는 첫 연결 (또는 재연결) 단계
    socket.on('set_player_info', (data) => {
        const { playerId, playerName } = data; // 클라이언트로부터 받은 playerName
        
        // 기존 재접속 대기 타이머가 있다면 클리어
        if (reconnectionTimeouts[playerId]) {
            clearTimeout(reconnectionTimeouts[playerId]);
            delete reconnectionTimeouts[playerId];
            console.log(`[서버 로그] 플레이어 ${playerName} (${playerId}) 재접속 대기 타이머 취소.`);
        }

        socketIdMap[socket.id] = playerId; // 새로운 socket.id와 playerId 매핑

        // 기존 플레이어인지, 새로운 플레이어인지 확인
        if (!playersData[playerId]) {
            // 새 플레이어 등록 (최초 접속 시 playerName 사용)
            playersData[playerId] = {
                id: playerId, 
                name: playerName, // 최초 등록 시 클라이언트가 보낸 닉네임 사용
                currentRoomId: null, // 새 플레이어는 방에 없음 (null)
                role: 'guest',
                status: '로비', // '로비', '대기', '준비', '게임 중'
                position: 0,
                color: getPlayerColor(), 
                inventory: [], 
                currentSocketId: socket.id, 
                // isConnecting: false, // 이 플래그는 reconnectionTimeouts로 대체
                statusEffects: {}, 
                laps: 0, 
                lastDiceRollPosition: 0, 
                isSavingActive: false, 
                savingStack: 0, 
                e_isSavingActive: false,
                e_savingStack: 0,
            };
            console.log(`[서버 로그] 새로운 플레이어 등록: ${playerName} (${playerId})`);
        } else {
            // 기존 플레이어 (재접속)
            const player = playersData[playerId];
            player.currentSocketId = socket.id; // socket.id 업데이트

            // 클라이언트가 유효한 닉네임을 보냈고, 서버에 저장된 닉네임이 없거나 기본값인 경우에만 업데이트
            if (playerName && playerName !== "null" && !playerName.startsWith('임시용사_') && !playerName.startsWith('기본용사_')) { // 닉네임이 null이 아니고 임시용사 아니면 업데이트
                 player.name = playerName; // 클라이언트가 보낸 새 닉네임으로 업데이트 (로그인 시)
            } else if (!player.name || player.name.startsWith('임시용사_') || player.name.startsWith('기본용사_')) {
                // 서버에 저장된 이름도 임시 이름이거나 없는데, 클라이언트가 임시 이름을 보내면 그대로 유지
                player.name = playerName; // 클라이언트가 보낸 임시용사 닉네임을 그대로 사용
            }


            console.log(`[서버 로그] 플레이어 재접속: ${player.name} (${playerId}), 새 소켓: ${socket.id}`);
            
            // 재접속 시 플레이어가 방에 이미 있다면 방의 플레이어 목록의 socket.id도 업데이트
            if (player.currentRoomId && rooms[player.currentRoomId]) {
                const room = rooms[player.currentRoomId];
                // room.players는 이미 playerId로 되어 있으므로, 해당 플레이어가 다시 접속한 사실만 알리면 됨
                socket.join(room.id); // 새로운 소켓을 기존 방에 조인
                emitPlayerListUpdate(room.id); // 방 안의 플레이어 목록 업데이트 (재접속 상태 반영)
                // 만약 게임 중이었다면 해당 방의 보드 이벤트 정보를 다시 보내줌
                if (room.status === 'playing' && room.assignedBoardEvents) {
                    io.to(socket.id).emit('board_events_update', room.assignedBoardEvents); // io.to(socket.id)
                }
            }
        }
        // 클라이언트에게 정보 설정 완료 확인 메시지 전송
        io.to(socket.id).emit('player_info_set_ack', { 
            playerId: playerId, 
            playerName: playersData[playerId].name, // 현재 서버에 저장된 닉네임 (갱신될 수 있음)
            currentRoomId: playersData[playerId].currentRoomId, // 현재 접속한 방 ID
            currentRoomName: playersData[playerId].currentRoomId ? rooms[playersData[playerId].currentRoomId].name : null, // 현재 접속한 방 이름
            playerRole: playersData[playerId].role // 현재 플레이어 역할
        });
    });

    // --- 클라이언트 요청: 방 목록 요청 ---
    socket.on('request_room_list', () => {
        emitRoomListUpdate();
    });

    // --- 클라이언트 요청: 방 생성 ---
    socket.on('create_room', (data) => {
        const playerId = socketIdMap[socket.id]; // 요청한 플레이어의 playerId
        if (!playerId || !playersData[playerId]) {
            io.to(socket.id).emit('server_message', '유효하지 않은 플레이어 정보입니다. 다시 로그인해주세요.');
            return;
        }

        const newRoomId = `room_${Math.random().toString(36).substring(2, 9)}`;
        rooms[newRoomId] = {
            id: newRoomId,
            name: data.roomName,
            hostPlayerId: playerId, // 방 생성자가 방장 (playerId 기준)
            players: [playerId], // 방에 playerId 저장
            maxPlayers: 5, // 최대 5명
            status: 'waiting', // 'waiting', 'playing'
            assignedBoardEvents: [], // 방 생성 시 빈 배열
            currentTurnIndex: 0 // 현재 턴 플레이어 인덱스
        };

        const player = playersData[playerId];
        player.currentRoomId = newRoomId;
        player.role = 'host';
        player.status = '준비';
        player.inventory = []; // 방 생성 시 인벤토리 비어있어야 함
        player.laps = 0; // 플레이어 laps 초기화
        player.lastDiceRollPosition = 0;
        player.isSavingActive = false;
        player.savingStack = 0;
        player.e_isSavingActive = false;
        player.e_savingStack = 0;

        socket.join(newRoomId); // Socket.IO의 Room 기능 사용

        console.log(`[서버 로그] ${player.name}님이 ${data.roomName}(${newRoomId}) 방을 생성했습니다.`);
        emitRoomListUpdate(); // 모든 클라이언트에 방 목록 업데이트
        emitPlayerListUpdate(newRoomId); // 방 안의 플레이어 목록 업데이트

        // 방 생성자에게 성공 메시지 전송
        io.to(socket.id).emit('room_created_success', { roomId: newRoomId, roomName: data.roomName });
    });

    // --- 클라이언트 요청: 방 참가 ---
    socket.on('join_room', (data) => {
        const playerId = socketIdMap[socket.id];
        if (!playerId || !playersData[playerId]) {
            io.to(socket.id).emit('server_message', '유효하지 않은 플레이어 정보입니다. 다시 로그인해주세요.');
            return;
        }
        
        const { roomId } = data;
        const room = rooms[roomId];

        if (room && room.players.length < room.maxPlayers && room.status === 'waiting') {
            // 이미 방에 속해있는지 확인
            if (playersData[playerId].currentRoomId) {
                io.to(socket.id).emit('room_join_failed', '이미 다른 방에 접속 중입니다. 기존 방을 나가주세요.');
                return;
            }

            room.players.push(playerId); // 방에 playerId 추가
            const player = playersData[playerId];
            player.currentRoomId = roomId;
            player.role = 'player'; // 참가자는 플레이어
            player.status = '대기';
            player.inventory = []; // 방 참가 시 인벤토리 비어있어야 함
            player.laps = 0; // 플레이어 laps 초기화
            player.lastDiceRollPosition = 0;
            player.isSavingActive = false;
            player.savingStack = 0;
            player.isProtect = false;
            player.e_savingStack = 0;
            player.e_isProtect = false;
            
            socket.join(roomId); // Socket.IO의 Room 기능 사용

            console.log(`[서버 로그] ${player.name}님이 ${room.name}(${roomId}) 방에 참가했습니다.`);
            emitRoomListUpdate(); // 모든 클라이언트에 방 목록 업데이트
            emitPlayerListUpdate(roomId); // 방 안의 플레이어 목록 업데이트

            // 참가자에게 성공 메시지 전송
            io.to(socket.id).emit('room_joined_success', { roomId: roomId, roomName: room.name });
        } else {
            let reason = '알 수 없는 이유';
            if (!room) reason = '방이 존재하지 않습니다';
            else if (room.players.length >= room.maxPlayers) reason = '방이 가득 찼습니다';
            else if (room.status !== 'waiting') reason = '이미 게임이 진행 중인 방입니다';
            io.to(socket.id).emit('room_join_failed', reason);
        }
    });

    // --- 헬퍼 함수: 방 나가기 로직 (중복 코드 방지) ---
    function handleLeaveRoom(playerId, emitSuccess = true) {
        if (!playersData[playerId]) return; // 이미 플레이어 데이터가 없으면 처리 안 함 (ex: disconnect 타이머에서 제거됨)
        
        const player = playersData[playerId];
        const roomId = player.currentRoomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        room.players = room.players.filter(id => id !== playerId); // 플레이어 목록에서 제거

        // 방장 처리: 방장이 나가면 새로운 방장 지정 또는 방 삭제
        if (room.hostPlayerId === playerId) {
            if (room.players.length > 0) {
                room.hostPlayerId = room.players[0]; // 남은 플레이어 중 첫 번째를 방장으로
                playersData[room.hostPlayerId].role = 'host';
                // io.to(roomId)는 모든 소켓에게 보내지만, 특정 소켓만 룸을 나가고 브로드캐스팅은 잘 됨.
                io.to(player.currentSocketId).emit('server_message', `${playersData[room.hostPlayerId].name}님이 새로운 방장이 되었습니다.`);
            } else {
                console.log(`[서버 로그] 방이 비어서 ${room.name}(${roomId}) 방을 삭제합니다.`);
                delete rooms[roomId]; // 방 삭제
            }
        }

        // 플레이어 데이터 초기화 및 업데이트
        player.currentRoomId = null;
        player.role = 'guest';
        player.status = '로비';
        player.position = 0; // 방 나가면 위치 초기화
        player.inventory = []; // 방 나가면 인벤토리 초기화
        player.statusEffects = {}; // 상태 효과 초기화 (무인도 등)
        player.laps = 0; // 바퀴 수 초기화
        player.lastDiceRollPosition = 0;
        player.isSavingActive = false;
        player.savingStack = 0;
        player.gotDebuffed = false;


        // 사용했던 색상을 availablePlayerColors에 다시 추가
        if (player.color && !availablePlayerColors.includes(player.color)) {
            availablePlayerColors.push(player.color);
        }

        // 해당 플레이어의 현재 소켓만 방을 나가도록 처리 (혹시 모르니)
        if (player.currentSocketId) {
             io.sockets.sockets.get(player.currentSocketId)?.leave(roomId);
        }

        console.log(`[서버 로그] ${player.name}님이 ${room.name || '알 수 없는'} 방을 나갔습니다.`);
        emitRoomListUpdate(); // 모든 클라이언트에 방 목록 업데이트
        if (rooms[roomId]) { // 방이 남아있다면 (삭제되지 않았다면)
            emitPlayerListUpdate(roomId); // 방 안의 플레이어 목록 업데이트
        }
        if (emitSuccess && player.currentSocketId) {
            io.to(player.currentSocketId).emit('left_room_success'); // 방 나가는 클라이언트에게 성공 메시지
        }
    }

    // --- 클라이언트 요청: 방에서 나가기 (클라이언트 측 버튼 클릭) ---
    socket.on('leave_room', () => {
        const playerId = socketIdMap[socket.id];
        if (playerId) {
            handleLeaveRoom(playerId, true); // true는 'left_room_success' emit
        }
    });

    // --- 플레이어 연결 끊김 처리 (브라우저 닫거나 새로고침 등) ---
    socket.on('disconnect', () => {
        console.log(`[서버 로그] 소켓 연결 끊김: ${socket.id}`);
        const playerId = socketIdMap[socket.id];

        // 연결이 끊긴 소켓에 playerId가 매핑되어 있다면
        if (playerId && playersData[playerId]) {
            // 이 플레이어에 대한 기존 타이머가 있다면 클리어
            if (reconnectionTimeouts[playerId]) {
                clearTimeout(reconnectionTimeouts[playerId]);
            }
            
            // 재접속 대기 타이머 설정
            reconnectionTimeouts[playerId] = setTimeout(() => {
                console.log(`[서버 로그] 플레이어 ${playersData[playerId].name} (${playerId}) 재접속 대기 시간 만료. 완전 제거.`);
                
                // 해당 플레이어가 어떤 방에 있었는지 찾기
                const roomHoldingPlayerId = playersData[playerId].currentRoomId;
                
                // 플레이어를 방에서 제거하는 로직을 호출 (handleLeaveRoom은 플레이어 데이터를 남겨두므로 삭제 필요)
                if (roomHoldingPlayerId && rooms[roomHoldingPlayerId]) {
                     handleLeaveRoom(playerId, false); // 방에서 플레이어 제거 및 룸 상태 업데이트 (emitSuccess는 false)
                }

                // playersData에서 플레이어 데이터 완전히 삭제
                if (playersData[playerId].color && !availablePlayerColors.includes(playersData[playerId].color)) {
                    availablePlayerColors.push(playersData[playerId].color);
                }
                delete playersData[playerId];
                delete socketIdMap[socket.id]; // 끊어진 소켓 ID 매핑도 삭제
                
                // 전역적으로 방 목록을 업데이트하여 빈 방 또는 정리된 방이 반영되도록 함
                emitRoomListUpdate();

            }, RECONNECT_TIMEOUT_MS); // 30초 대기
            
        } else {
            // playerId가 없는 연결 (예: 로그인 안 된 상태의 접속) 또는 이미 제거된 플레이어
            console.log(`[서버 로그] 알 수 없는 플레이어 소켓 ${socket.id} 연결 끊김. 또는 이미 처리됨.`);
            delete socketIdMap[socket.id]; 
        }
    });

    // --- 게임 로직 관련 이벤트 (임시/추후 상세 구현) ---
    socket.on('player_ready', () => {
        const playerId = socketIdMap[socket.id];
        if (!playerId || !playersData[playerId]) {
            io.to(socket.id).emit('server_message', '준비 실패: 플레이어 정보 없음.');
            return;
        }

        const player = playersData[playerId];
        const roomId = player.currentRoomId;

        if (roomId && rooms[roomId]) {
            // 현재 상태에 따라 토글
            player.status = (player.status === '대기') ? '준비' : '대기';
            console.log(`[서버 로그] ${player.name}님의 상태: ${player.status}`);
            emitPlayerListUpdate(roomId); // 상태 업데이트 브로드캐스트

            // 방장인 경우, 모든 플레이어 준비 완료 시 게임 시작 버튼 활성화
            if (player.role === 'host') {
                const room = rooms[roomId];
                // room.players에 있는 모든 실제 플레이어들이 '준비' 상태인지 확인 (AI 아님)
                const allPlayersReady = room.players.every(pid => playersData[pid]?.status === '준비' || playersData[pid]?.role === 'host'); // 방장도 준비로 간주
                if (allPlayersReady && room.players.length >= 2) { // 최소 2명 필요
                    io.to(socket.id).emit('game_state_update', { canStart: true }); // 방장에게만 게임 시작 가능 알림
                } else {
                    io.to(socket.id).emit('game_state_update', { canStart: false });
                }
            }
        }
    });

    socket.on('start_game', () => {
        const playerId = socketIdMap[socket.id];
        if (!playerId || !playersData[playerId]) {
            io.to(socket.id).emit('server_message', '게임 시작 실패: 플레이어 정보 없음.');
            return;
        }

        const player = playersData[playerId];
        const roomId = player.currentRoomId;
        

        if (roomId && rooms[roomId] && player.role === 'host') {
            const room = rooms[roomId];
            const allReady = room.players.every(pid => playersData[pid]?.status === '준비' || playersData[pid]?.role === 'host');
            if (allReady && room.players.length >= 2) {
                room.status = 'playing'; // 방 상태를 '게임 중'으로 변경

                // --- 보드 칸 이벤트 랜덤 배정 ---
                const assignedEvents = [];
                // 48칸 중 시작칸(0번)과 무인도 칸(12번) 제외하고 나머지 46칸에 이벤트 배정
                // assignedEvents 배열은 0번 인덱스부터 시작하며, 보드 칸의 1번 인덱스에 매핑.
                // 즉, assignedEvents[0]은 보드칸 index 1에, assignedEvents[1]은 보드칸 index 2에.
                for (let i = 0; i < TOTAL_BOARD_CELLS - 1; i++) { // 0번 칸 제외, assignedEvents 배열의 크기는 47
                    if (i + 1 === JAIL_CELL_INDEX) { // 무인도 칸은 고정 (assignedEvents의 11번 인덱스)
                        assignedEvents.push({ type: 'event', name: '무인도', effect: { type: 'jail', skipTurns: 2 } });
                    } else {
                        assignedEvents.push(getRandomWeightedEvent(boardEventTypes));
                    }
                }

                room.assignedBoardEvents = assignedEvents;
                io.to(roomId).emit('board_events_update', assignedEvents); // 해당 룸 클라이언트에게만 보드 이벤트 전송

                io.to(roomId).emit('game_started'); // 해당 룸 플레이어에게 게임 시작 알림

                // 첫 턴 시작 로직 (방장이 첫 턴을 가지거나, 무작위 선정 등)
                // 현재 턴 플레이어는 roomId의 players 배열에 있는 순서대로
                room.currentTurnIndex = 0;
                let currentTurnPlayerId = room.players[room.currentTurnIndex];
                io.to(roomId).emit('turn_update', {
                    currentPlayerId: currentTurnPlayerId,
                    currentPlayerName: playersData[currentTurnPlayerId].name
                });
            } else {
                io.to(socket.id).emit('server_message', '모든 플레이어가 준비되지 않았거나 최소 인원 부족합니다.');
            }
        } else {
            io.to(socket.id).emit('server_message', '게임 시작 권한이 없습니다.');
        }
    });

    // 주사위 굴림 (운명의 주사위)
    socket.on('roll_dice', () => {
        const playerId = socketIdMap[socket.id];
        if (!playerId || !playersData[playerId]) {
            io.to(socket.id).emit('server_message', '주사위 굴림 실패: 플레이어 정보 없음.');
            return;
        }
        
        const player = playersData[playerId];
        const roomId = player.currentRoomId;
        const room = rooms[roomId];

        if (!room || room.status !== 'playing') {
            io.to(socket.id).emit('server_message', '게임이 시작되지 않습니다.');
            return;
        }
        
        // 현재 턴인 플레이어만 주사위를 굴릴 수 있도록
        if (room.players[room.currentTurnIndex] !== playerId) {
            io.to(socket.id).emit('server_message', '지금은 당신의 턴이 아닙니다!');
            return;
        }

        // 무인도 상태 체크 및 턴 스킵
        if (player.statusEffects.jail && player.statusEffects.jail.skipTurns > 0) {
            player.statusEffects.jail.skipTurns--;
            io.to(roomId).emit('server_message', `${player.name}님은 무인도에서 ${player.statusEffects.jail.skipTurns + 1}번째 턴을 쉬고 있습니다. (남은 턴: ${player.statusEffects.jail.skipTurns})`);
            if (player.statusEffects.jail.skipTurns === 0) {
                delete player.statusEffects.jail; // 무인도 상태 해제
                io.to(roomId).emit('server_message', `${player.name}님은 무인도에서 탈출했습니다!`);
            }
            emitPlayerListUpdate(roomId); // 상태 업데이트

            // 턴만 넘김 (주사위 굴리지 않음)
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
            const nextPlayerId = room.players[room.currentTurnIndex];
            io.to(roomId).emit('turn_update', {
                currentPlayerId: nextPlayerId,
                currentPlayerName: playersData[nextPlayerId].name
            });
            return; // 주사위 굴림 로직을 건너뜀
        }
        // 한 번 쉬기 상태 체크 및 턴 스킵 (추가/수정될 로직)
        if (player.statusEffects.nextTurnSkip && player.statusEffects.nextTurnSkip.turns > 0) {
            player.statusEffects.nextTurnSkip.turns--;
            io.to(roomId).emit('server_message', `${player.name}님은 벌칙으로 이번 턴을 쉽니다. (남은 스킵 턴: ${player.statusEffects.nextTurnSkip.turns})`);
            if (player.statusEffects.nextTurnSkip.turns === 0) {
                delete player.statusEffects.nextTurnSkip; // 효과 사용 후 제거
            }
            emitPlayerListUpdate(roomId);

            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
            const nextPlayerId = room.players[room.currentTurnIndex];
            io.to(roomId).emit('turn_update', {
                currentPlayerId: nextPlayerId,
                currentPlayerName: playersData[nextPlayerId].name
            });
            return; // 턴 스킵 후 함수 종료
        }

        // --- 수정 시작: nextRollModifier 상태 체크 및 주사위 굴림 값에 반영 --
        let roll = Math.floor(Math.random() * 6) + 1; // 1~6 굴림
        if (player.statusEffects.nextRollModifier) {
            
            const originalRoll = roll; // 원본 굴림 값 저장
            roll += player.statusEffects.nextRollModifier; // 수정치 적용
            if (roll < 1) roll = 1; // 주사위 값은 최소 1
            io.to(roomId).emit('server_message', `${player.name}님의 주사위 ${originalRoll}에 ${player.statusEffects.nextRollModifier}이(가) 적용되어 ${roll}(이) 됩니다.`);
            delete player.statusEffects.nextRollModifier; // 효과 사용 후 제거
            emitPlayerListUpdate(roomId); // 상태 업데이트
        }
        // --- 수정 끝 ---
        
        // 저장의 주사위가 활성화된 경우
        if (player.isSavingActive) {
            
            player.savingStack += 1;
            //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
        }
        if (player.e_isSavingActive) {
            
            player.e_savingStack += 2;
            //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
        }
        

        const { newPosition, isWin } = updatePlayerPositionAndCheckWin(roomId, player, player.position, roll, false);

        
        if (isWin) { 
            io.to(roomId).emit('game_ended', { winnerId: playerId, winnerName: player.name });
            // 게임 종료 후 방 및 플레이어 초기화
            resetRoomAndPlayersForNewGame(roomId);
        } else {
            executeBoardEvent(roomId, player);

            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
            const nextPlayerId = room.players[room.currentTurnIndex];
            
            io.to(roomId).emit('turn_update', { 
                currentPlayerId: nextPlayerId,
                currentPlayerName: playersData[nextPlayerId].name
            });
        }
    });

    // --- 아이템 주사위 사용 ---
    // 벌칙의 주사위 이벤트 목록 (노래를 부릅니다 제거)
    const penaltyEvents = [
        (player, target) => ({
            message: `${player.name}님에 의해 지목된 ${target.name}님은 뒤로 다섯 칸 이동합니다.`,
            effect: (targetPlayer) => { 
                const oldPos = targetPlayer.position;
                const { newPos, isWin } = updatePlayerPositionAndCheckWin(targetPlayer.currentRoomId, targetPlayer, oldPos, -5, true); 
                return { newPos, isWin };
            }
        }),
        (player, target) => ({
            message: `${player.name}님에 의해 지목된 ${target.name}님은 무인도로 갑니다.`,
            effect: (targetPlayer) => {
                targetPlayer.position = JAIL_CELL_INDEX;
                targetPlayer.statusEffects.jail = { skipTurns: 2, currentSkip: 0 };
                return { newPos: targetPlayer.position, isWin: false }; 
            }
        }),
        (player, target) => ({ message: `${player.name}님에 의해 지목된 ${target.name}님은 모든 이벤트 주사위가 몰수됩니다.`, effect: (targetPlayer) => { targetPlayer.inventory = targetPlayer.inventory.filter(item => item === '운명의 주사위'); return { newPos: targetPlayer.position, isWin: false }; } }), 
        (player, target) => ({ message: `${player.name}님에 의해 지목된 ${target.name}님은 한 번 쉽니다.`, effect: (targetPlayer) => { targetPlayer.statusEffects.nextTurnSkip = { turns: 1 }; return { newPos: targetPlayer.position, isWin: false }; } }), 
        (player, target, room) => { 
            const playersInRoomArr = getPlayersInRoom(room.id); // 수정: getPlayersInRoom 헬퍼 함수 사용
            const sortedPlayers = [...playersInRoomArr].sort((a, b) => a.position - b.position);
            const lowestRankPlayer = sortedPlayers[0]; 

            if (lowestRankPlayer && lowestRankPlayer.id !== target.id) {
                const tempTargetPos = target.position; 
                target.position = lowestRankPlayer.position;
                lowestRankPlayer.position = tempTargetPos; 

                return {
                    message: `${player.name}님에 의해 지목된 ${target.name}님은 현재 꼴등(${lowestRankPlayer.name})과 위치를 바꿉니다.`,
                    effect: () => {}, 
                    additionalUpdates: [ 
                        { playerId: lowestRankPlayer.id, newPosition: lowestRankPlayer.position, oldPosition: tempTargetPos } 
                    ]
                };
            }
            return { message: `${player.name}님이 ${target.name}님을 지목했으나 꼴등과의 위치 변경이 적용되지 않았습니다.`, effect: () => {} }; 
        },
        (player, target) => ({ message: `${player.name}님에 의해 지목된 ${target.name}님은 다음 주사위 수에 3을 뺍니다.`, effect: (targetPlayer) => { targetPlayer.statusEffects.nextRollModifier = -3; return { newPos: targetPlayer.position, isWin: false }; } }),
        (player, target, room) => { 
            const tempPlayerPos = player.position; 
            player.position = target.position;
            target.position = tempPlayerPos; 

            return { 
                message: `${player.name}님이 ${target.name}님과 자리를 바꿉니다. (선택 UI는 나중에 구현)`,
                effect: (targetPlayer) => { 
                    const tempPosEffect = player.position; // 실제 사용자의 위치
                    const tempTargetPosEffect = targetPlayer.position; // 실제 타겟의 위치

                    // 업데이트할 때 직접 위치를 바꿔주는게 아니라, 그 위치를 반환해야함.
                    return {
                        newPos: tempTargetPosEffect, // 타겟의 최종 위치 (바뀐 위치)
                        isWin: false // 여기서는 승리여부 판단 안함
                    };
                },
                additionalUpdates: [
                    { playerId: player.id, newPosition: player.position, oldPosition: tempPlayerPos } 
                ]
            };
        },
        (player, target) => ({
            message: `${player.name}님에 의해 지목된 ${target.name}님은 11칸 뒤로 갑니다.`,
            effect: (targetPlayer) => { 
                const oldPos = targetPlayer.position;
                const { newPos, isWin } = updatePlayerPositionAndCheckWin(targetPlayer.currentRoomId, targetPlayer, oldPos, -11, true); 
                return { newPos, isWin };
            }
        }),
    ];
    socket.on('use_item_dice', (data) => {
        const { diceType, targetPlayerId, selectedDice } = data; 
        const playerId = socketIdMap[socket.id]; 
        if (!playerId || !playersData[playerId]) {
            io.to(socket.id).emit('server_message', '아이템 주사위 사용 실패: 플레이어 정보 없음.');
            return;
        }
        
        const player = playersData[playerId];
        const roomId = player.currentRoomId;
        const room = rooms[roomId];

        if (!room || room.status !== 'playing') {
            io.to(socket.id).emit('server_message', '게임 중이 아닐 때 아이템 주사위를 사용할 수 없습니다.');
            return;
        }

        if (diceType === 'select_dice_choice') {
            const playerId = socketIdMap[socket.id];
            if (!playerId || !playersData[playerId]) {
                io.to(socket.id).emit('server_message', '주사위 선택 실패: 플레이어 정보 없음.');
                return;
            }
            const player = playersData[playerId];
            const roomId = player.currentRoomId;

            // 모든 획득 가능한 주사위 목록을 다시 생성하여 유효성 검사
            const allAvailableDiceNames = boardEventTypes
                                            .filter(e => e.type === 'get_dice')
                                            .map(e => e.value);
            if (selectedDice && allAvailableDiceNames.includes(selectedDice)) { // 선택된 주사위가 유효하다면
                player.inventory.push(selectedDice);
                io.to(player.currentSocketId).emit('server_message', `${player.name}님이 '${selectedDice}'을(를) 선택하여 획득했습니다!`);
                emitPlayerListUpdate(roomId); // 인벤토리 업데이트
            } else {
                io.to(player.currentSocketId).emit('server_message', `${player.name}님이 주사위 선택을 취소했거나 유효하지 않습니다. 아무것도 획득하지 못했습니다.`);
            }
            return; // select_dice_choice는 인벤토리 소모를 건너뜀
        }



        const diceIndex = player.inventory.indexOf(diceType);
        if (diceIndex === -1) {
            io.to(socket.id).emit('server_message', '해당 주사위를 가지고 있지 않습니다.');
            return;
        }
        player.inventory.splice(diceIndex, 1); 

        let targetPlayer = playersData[targetPlayerId]; 

        if(player.gotDebuffed === true){
            gotDebuffed = false;

        }

        switch (diceType) {
            case '플러스의 주사위':
                const plusRoll = Math.floor(Math.random() * 6) + 1; 
                const oldPlusPos = player.position;
                const { newPosition: p_newPos, isWin: p_isWin } = updatePlayerPositionAndCheckWin(roomId, player, oldPlusPos, plusRoll, true);
                
                io.to(roomId).emit('server_message', `${player.name}님이 플러스 주사위로 ${plusRoll}칸 이동했습니다.`);
                
                if (p_isWin) {
                    io.to(roomId).emit('game_ended', { winnerId: player.id, winnerName: player.name });
                    resetRoomAndPlayersForNewGame(roomId);
                } else {
                    executeBoardEvent(roomId, player); 
                }

                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '마이너스의 주사위':
                if (!targetPlayerId || !targetPlayer || player.id === targetPlayerId) {
                    io.to(socket.id).emit('server_message', '마이너스 주사위는 자신을 지목할 수 없습니다. 유효한 대상을 선택해주세요.');
                    player.inventory.push(diceType); 
                    return;
                }
                if(targetPlayer.isProtect != true){
                    const minusRoll = -1;
                    const oldMinusPos = targetPlayer.position;
                    const { newPosition: m_newPos, isWin: m_isWin } = updatePlayerPositionAndCheckWin(roomId, targetPlayer, oldMinusPos, minusRoll, true);
                    io.to(roomId).emit('server_message', `${player.name}님이 마이너스 주사위로 ${targetPlayer.name}님을 1칸 뒤로 보냈습니다.`);
                    if (m_isWin) {
                        io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                        resetRoomAndPlayersForNewGame(roomId);
                    } else {
                        executeBoardEvent(roomId, targetPlayer); 
                    }
                }else{
                    io.to(roomId).emit('server_message', `${targetPlayer.name}님이 보호의 주사위 사용에 성공했습니다! (마이너스의 주사위 면역)`);
                    targetPlayer.isProtect = false;
                    //return;
                }
                

                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;
            
            case '저주의 주사위':
                if (!targetPlayerId || !targetPlayer || player.id === targetPlayerId) {
                    io.to(socket.id).emit('server_message', '저주의 주사위는 자신을 지목할 수 없습니다. 유효한 대상을 선택해주세요.');
                    player.inventory.push(diceType); 
                    return;
                }
                if(targetPlayer.isProtect != true){
                    const curseRoll = -(Math.floor(Math.random() * 6) + 1); 
                    const oldCursePos = targetPlayer.position;
                    const { newPosition: c_newPos, isWin: c_isWin } = updatePlayerPositionAndCheckWin(roomId, targetPlayer, oldCursePos, curseRoll, true);
                    io.to(roomId).emit('server_message', `${player.name}님이 저주의 주사위로 ${targetPlayer.name}님을 ${-curseRoll}칸 뒤로 보냈습니다.`);  
                    if (c_isWin) {
                        io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                        resetRoomAndPlayersForNewGame(roomId);
                    } else {
                        executeBoardEvent(roomId, targetPlayer);
                    } 
                }else{
                    io.to(roomId).emit('server_message', `${targetPlayer.name}님이 보호의 주사위 사용에 성공했습니다! (저주의 주사위 면역)`);
                    targetPlayer.isProtect = false;
                }
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;
            
            case '벌칙의 주사위':
                if (!targetPlayerId || !targetPlayer) { 
                    io.to(socket.id).emit('server_message', '벌칙 주사위는 유효한 대상을 선택해야 합니다.');
                    player.inventory.push(diceType); 
                    return;
                }
                const randomPenaltyIndex = Math.floor(Math.random() * penaltyEvents.length);
                const chosenPenalty = penaltyEvents[randomPenaltyIndex];
                const penaltyResult = chosenPenalty(player, targetPlayer, room); 
                
                io.to(roomId).emit('server_message', `[벌칙] ${penaltyResult.message}`);
                if (penaltyResult.effect) {
                    const oldPenaltyPos = targetPlayer.position;
                    const effectResult = penaltyResult.effect(targetPlayer); 
                    
                    if (targetPlayer.position !== oldPenaltyPos) { 
                        io.to(roomId).emit('dice_roll_result', {
                            playerId: targetPlayer.id,
                            playerName: targetPlayer.name,
                            roll: targetPlayer.position - oldPenaltyPos, 
                            oldPosition: oldPenaltyPos,
                            newPosition: targetPlayer.position,
                            isEventMove: true 
                        });
                        if (effectResult && effectResult.isWin) { 
                            io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                            resetRoomAndPlayersForNewGame(roomId);
                        } else {
                             executeBoardEvent(roomId, targetPlayer); 
                        }
                    }
                    if (penaltyResult.additionalUpdates && !(effectResult && effectResult.isWin)) { 
                        penaltyResult.additionalUpdates.forEach(update => {
                             io.to(roomId).emit('dice_roll_result', {
                                playerId: update.playerId,
                                playerName: playersData[update.playerId].name,
                                roll: playersData[update.playerId].position - update.oldPosition,
                                oldPosition: update.oldPosition,
                                newPosition: update.newPosition,
                                isEventMove: true
                            });
                        });
                    }
                }
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;
            
            case '고정의 주사위':
                if (!targetPlayerId || !targetPlayer || player.id === targetPlayerId) {
                    io.to(socket.id).emit('server_message', '고정의 주사위는 자신을 지목할 수 없습니다. 유효한 대상을 선택해주세요.');
                    player.inventory.push(diceType); 
                    return;
                }
                if (typeof targetPlayer.lastDiceRollPosition === 'number' && targetPlayer.position !== targetPlayer.lastDiceRollPosition) { 
                    if(targetPlayer.isProtect != true){
                        const oldFixedPos = targetPlayer.position;
                        const fixedPos = targetPlayer.lastDiceRollPosition; 
                        const fixedMoveRoll = fixedPos - oldFixedPos; 
                        const { newPosition: f_newPos, isWin: f_isWin } = updatePlayerPositionAndCheckWin(roomId, targetPlayer, oldFixedPos, fixedMoveRoll, true); 
                        io.to(roomId).emit('server_message', `${player.name}님이 고정의 주사위로 ${targetPlayer.name}님을 이전 위치로 돌려보냈습니다.`);
                        if (f_isWin) {
                            io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                            resetRoomAndPlayersForNewGame(roomId);
                        } else {
                            executeBoardEvent(roomId, targetPlayer);
                        }
                    }else{
                        io.to(roomId).emit('server_message', `${targetPlayer.name}님이 보호의 주사위 사용에 성공했습니다! (고정의 주사위 면역)`);
                        targetPlayer.isProtect = false;
                    }
                } else {
                    io.to(socket.id).emit('server_message', `${targetPlayer.name}님의 이전 위치가 없거나 현재 위치와 동일하여 고정 주사위를 사용할 수 없습니다.`);
                    player.inventory.push(diceType); 
                }
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '무작위의 주사위':
                const availableDiceToGet = boardEventTypes.filter(e => e.type === 'get_dice').map(e => e.value);
                if (availableDiceToGet.length === 0) {
                     io.to(socket.id).emit('server_message', `현재 획득 가능한 주사위가 없습니다.`);
                     player.inventory.push(diceType); 
                     break;
                }
                const randomDiceToGet = availableDiceToGet[Math.floor(Math.random() * availableDiceToGet.length)];
                player.inventory.push(randomDiceToGet);
                io.to(roomId).emit('server_message', `${player.name}님이 무작위 주사위로 '${randomDiceToGet}'을(를) 획득했습니다!`);
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '확률의 주사위':
                const isSuccess = Math.random() < 0.2; 
                if (isSuccess) {
                    const chanceRoll = Math.floor(Math.random() * 5) + 7; 
                    const oldChancePos = player.position;
                    const { newPosition: ch_newPos, isWin: ch_isWin } = updatePlayerPositionAndCheckWin(roomId, player, oldChancePos, chanceRoll, true);
                    
                    io.to(roomId).emit('server_message', `${player.name}님이 확률 주사위 성공! ${chanceRoll}칸 이동했습니다.`);
                    
                    if (ch_isWin) {
                        io.to(roomId).emit('game_ended', { winnerId: player.id, winnerName: player.name });
                        resetRoomAndPlayersForNewGame(roomId);
                    } else {
                        executeBoardEvent(roomId, player);
                    }
                } else {
                    io.to(roomId).emit('server_message', `${player.name}님이 확률 주사위 실패! 아무 일도 일어나지 않았습니다.`);
                }
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;
            
            case '보호의 주사위':
                if(player.isProtect != true){
                    player.isProtect = true;
                    io.to(roomId).emit('server_message', `${player.name}님이 보호의 주사위를 사용했습니다!`);
                }
                else{
                    io.to(roomId).emit('server_message', `${player.name}님이 보호의 주사위 사용에 실패했습니다. (보호의 주사위 사용 중, 또 다시 보호의 주사위를 사용할 수 없음!)`);
                }

                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '강화의 주사위':
                const randomEnhancedDice = enhancedDiceTypes[Math.floor(Math.random() * enhancedDiceTypes.length)].value;
                player.inventory.push(randomEnhancedDice);
                io.to(roomId).emit('server_message', `${player.name}님이 강화 주사위로 '${randomEnhancedDice}'을(를) 획득했습니다!`);
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;
            
            case '저장의 주사위':
                if (player.e_isSavingActive && player.isSavingActive) {
                    io.to(socket.id).emit('server_message', '저장 주사위는 이미 활성화되어 있습니다.');
                    player.inventory.push(diceType); 
                    return;
                }
                player.isSavingActive = true;
                player.savingStack = 0;
                player.inventory.push('저장 주사위 스택 받기'); 
                io.to(roomId).emit('server_message', `${player.name}님 저장의 주사의 사용, 저장 시작!`);
                break;
            
            case '저장 주사위 스택 받기':
                if (!player.isSavingActive) {
                    io.to(socket.id).emit('server_message', '저장 모드가 활성화되어 있지 않습니다.');
                    player.inventory.push(diceType); 
                    return;
                }
                const stackMove = player.savingStack;
                const oldSavePos = player.position;
                const { newPosition: s_newPos, isWin: s_isWin } = updatePlayerPositionAndCheckWin(roomId, player, oldSavePos, stackMove, true);
                
                io.to(roomId).emit('server_message', `${player.name}님이 저장 주사위 스택 받기로 ${stackMove}칸 이동했습니다!`);
                player.isSavingActive = false;
                player.savingStack = 0;

                if (s_isWin) {
                    io.to(roomId).emit('game_ended', { winnerId: player.id, winnerName: player.name });
                    resetRoomAndPlayersForNewGame(roomId);
                } else {
                    executeBoardEvent(roomId, player);
                }
                break;
                
            case '강화 운명의 주사위':
                const enhancedRoll = Math.floor(Math.random() * 6) + 5; 
                const oldEnhancedPos = player.position;
                const { newPosition: eh_newPos, isWin: eh_isWin } = updatePlayerPositionAndCheckWin(roomId, player, oldEnhancedPos, enhancedRoll, true);
                
                io.to(roomId).emit('server_message', `${player.name}님이 강화 운명의 주사위로 ${enhancedRoll}칸 이동했습니다!`);
                
                if (eh_isWin) {
                    io.to(roomId).emit('game_ended', { winnerId: player.id, winnerName: player.name });
                    resetRoomAndPlayersForNewGame(roomId);
                } else {
                    executeBoardEvent(roomId, player);
                }
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '강화 플러스의 주사위':
                if (!targetPlayerId || !targetPlayer || player.id === targetPlayerId) {
                    io.to(socket.id).emit('server_message', '강화 플러스의 주사위는 자신을 지목할 수 없습니다. 유효한 대상을 선택해주세요.');
                    player.inventory.push(diceType); 
                    return; 
                }
                const enhancedPlusRoll = Math.floor(Math.random() * 4) + 5
                const enhancedPlusRoll_opponent = -(Math.floor(Math.random() * 3) + 2);
                const oldenhancedPlusPos = player.position;
                const oldenhancedPlusPos_opponent = targetPlayer.position;
                if(targetPlayer.isProtect != true){
                    const { newPosition: epo_newPos, isWin: epo_isWin } = updatePlayerPositionAndCheckWin(roomId, targetPlayer, oldenhancedPlusPos_opponent, enhancedPlusRoll_opponent, true);
                    io.to(roomId).emit('server_message', `${player.name}님이 강화 플러스의 주사위로 ${targetPlayer.name}님을 ${-enhancedPlusRoll_opponent}칸 뒤로 보냈습니다.`);
                    if (epo_isWin) {
                        io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                        resetRoomAndPlayersForNewGame(roomId);
                    } else {
                        executeBoardEvent(roomId, targetPlayer); 
                    }
                }
                else{
                    io.to(roomId).emit('server_message', `${targetPlayer.name}님이 보호의 주사위 사용에 성공했습니다! (강화 보호의 주사위 면역)`);
                    targetPlayer.isProtect = false;
                }
                const { newPosition: ep_newPos, isWin: ep_isWin } = updatePlayerPositionAndCheckWin(roomId, player, oldenhancedPlusPos, enhancedPlusRoll, true);
                io.to(roomId).emit('server_message', `${player.name}님이 강화 플러스의 주사위로 ${enhancedPlusRoll}칸 이동했습니다.`);
                if (ep_isWin) {
                    io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                    resetRoomAndPlayersForNewGame(roomId);
                } else {
                    executeBoardEvent(roomId, targetPlayer); 
                }
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '강화 마이너스의 주사위':
                if (!targetPlayerId || !targetPlayer || player.id === targetPlayerId) {
                    io.to(socket.id).emit('server_message', '강화 마이너스의 주사위는 자신을 지목할 수 없습니다. 유효한 대상을 선택해주세요.');
                    player.inventory.push(diceType); 
                    return; 
                }
                const enhancedMinusRoll = Math.floor(Math.random() * 6) + 1
                const enhancedMinusRoll_opponent = -(Math.floor(Math.random() * 3) + 2);
                const oldenhancedMinusPos = player.position;
                const oldenhancedMinusPos_opponent = targetPlayer.position;
                const { newPosition: em_newPos, isWin: em_isWin } = updatePlayerPositionAndCheckWin(roomId, player, oldenhancedMinusPos, enhancedMinusRoll, true);
                if(targetPlayer.isProtect != true){
                    const { newPosition: emo_newPos, isWin: emo_isWin } = updatePlayerPositionAndCheckWin(roomId, targetPlayer, oldenhancedMinusPos_opponent, enhancedMinusRoll_opponent, true);
                    io.to(roomId).emit('server_message', `${player.name}님이 강화 마이너스의 주사위로 ${targetPlayer.name}님을 ${-enhancedMinusRoll_opponent}칸 뒤로 보냈습니다.`);
                    if (emo_isWin) {
                        io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                        resetRoomAndPlayersForNewGame(roomId);
                    } else {
                        executeBoardEvent(roomId, targetPlayer); 
                    }
                }
                else{
                    io.to(roomId).emit('server_message', `${targetPlayer.name}님이 보호의 주사위 사용에 성공했습니다! (강화 마이너스의 주사위 면역)`);
                    targetPlayer.isProtect = false;
                }
                io.to(roomId).emit('server_message', `${player.name}님이 강화 마이너스의 주사위로 ${enhancedMinusRoll}칸 이동했습니다.`);
                
                if (em_isWin) {
                    io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                    resetRoomAndPlayersForNewGame(roomId);
                } else {
                    executeBoardEvent(roomId, targetPlayer); 
                }
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '강화 저주의 주사위':
                if (!targetPlayerId || !targetPlayer || player.id === targetPlayerId) {
                    io.to(socket.id).emit('server_message', '강화 저주의 주사위는 자신을 지목할 수 없습니다. 유효한 대상을 선택해주세요.');
                    player.inventory.push(diceType); 
                    return; 
                }
                const enhancedCurseRoll = -(Math.floor(Math.random() * 6) + 5);
                const oldenhancedCursePos = targetPlayer.position;         
                if(targetPlayer.isProtect != true){
                    const { newPosition: ec_newPos, isWin: ec_isWin } = updatePlayerPositionAndCheckWin(roomId, targetPlayer, oldenhancedCursePos, enhancedCurseRoll, true);
                    io.to(roomId).emit('server_message', `${player.name}님이 강화 저주의 주사위로 ${targetPlayer.name}님을 ${-enhancedCurseRoll}칸 뒤로 보냈습니다.`);
                    if (ec_isWin) {
                        io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                        resetRoomAndPlayersForNewGame(roomId);
                    } else {
                        executeBoardEvent(roomId, targetPlayer); 
                    }
                } else{
                    io.to(roomId).emit('server_message', `${targetPlayer.name}님이 보호의 주사위 사용에 성공했습니다! (강화 저주의 주사위 면역)`);
                    targetPlayer.isProtect = false;
                }

                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '강화 확률의 주사위':
                const en_isSuccess = Math.random() < 0.35;
                if (en_isSuccess) {
                    const enchancedChanceRoll = Math.floor(Math.random() * 9) + 7
                    const oldenhancedChancePos = player.position;
                    const { newPosition: ech_newPos, isWin: ech_isWin } = updatePlayerPositionAndCheckWin(roomId, player, oldenhancedChancePos,enchancedChanceRoll, true);

                    io.to(roomId).emit('server_message', `${player.name}님이 강화 확률의 주사위 성공! ${enchancedChanceRoll}칸 이동했습니다.`);

                    if(ech_isWin){
                        io.to(roomId).emit('game_ended', { winnerId: player.id, winnerName: player.name });
                        resetRoomAndPlayersForNewGame(roomId);
                    } else{
                        executeBoardEvent(roomId, player);
                    }
                } else{
                    io.to(roomId).emit('server_message', `${player.name}님이 강화 확률의 주사위 실패! 아무런 일도 일어나지 않았습니다.`)
                }
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break

            case '강화 무작위의 주사위':
                const enhanced_availableDiceToGet = boardEventTypes.filter(e => e.type === 'get_dice').map(e => e.value);
                if (enhanced_availableDiceToGet.length === 0) {
                     io.to(socket.id).emit('server_message', `현재 획득 가능한 주사위가 없습니다.`);
                     player.inventory.push(diceType); 
                     break;
                }
                const enhanced_randomDiceToGet_one = enhanced_availableDiceToGet[Math.floor(Math.random() * enhanced_availableDiceToGet.length)];
                player.inventory.push(enhanced_randomDiceToGet_one);
                io.to(roomId).emit('server_message', `${player.name}님이 강화 무작위 주사위로 '${enhanced_randomDiceToGet_one}'을(를) 획득했습니다!`);
                const enhanced_randomDiceToGet_two = enhanced_availableDiceToGet[Math.floor(Math.random() * enhanced_availableDiceToGet.length)];
                player.inventory.push(enhanced_randomDiceToGet_two);
                io.to(roomId).emit('server_message', `${player.name}님이 강화 무작위 주사위로 '${enhanced_randomDiceToGet_two}'을(를) 획득했습니다!`);

                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '강화 보호의 주사위':
                if (!targetPlayerId || !targetPlayer || player.id === targetPlayerId) {
                    io.to(socket.id).emit('server_message', '강화 보호의 주사위는 자신을 지목할 수 없습니다. 유효한 대상을 선택해주세요.');
                    player.inventory.push(diceType); 
                    return; 
                }
                const enhancedProtectRoll = -(Math.floor(Math.random() * 4) + 1);
                const oldenhancedProtectPos = targetPlayer.position;         
                if(player.isProtect != true){
                    player.isProtect = true;
                    io.to(roomId).emit('server_message', `${player.name}님이 강화 보호의 주사위를 사용했습니다!`);
                }
                else{
                    io.to(roomId).emit('server_message', `${player.name}님이 강화 보호의 주사위 사용에 실패했습니다. (보호의 주사위 사용 중, 또 다시 보호의 주사위를 사용할 수 없음!)`);
                }
                if(targetPlayer.isProtect != true){ //보호의 주사위 사용 아니라면
                    const { newPosition: epr_newPos, isWin: epr_isWin } = updatePlayerPositionAndCheckWin(roomId, targetPlayer, oldenhancedProtectPos, enhancedProtectRoll, true);
                    io.to(roomId).emit('server_message', `${player.name}님이 강화 보호의 주사위로 ${targetPlayer.name}님을 ${-enhancedProtectRoll}칸 뒤로 보냈습니다.`);
                    if (epr_isWin) {
                        io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                        resetRoomAndPlayersForNewGame(roomId);
                    } else {
                        executeBoardEvent(roomId, targetPlayer); 
                    }
                } else{
                    io.to(roomId).emit('server_message', `${targetPlayer.name}님이 보호의 주사위 사용에 성공했습니다! (강화 보호의 주사위 면역)`);
                    targetPlayer.isProtect = false;
                }

                // if (epr_isWin) {
                //     io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                //     resetRoomAndPlayersForNewGame(roomId);
                // } else {
                //     executeBoardEvent(roomId, targetPlayer); 
                // }

                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break

            case '강화 고정의 주사위':
                if (!targetPlayerId || !targetPlayer || player.id === targetPlayerId) {
                    io.to(socket.id).emit('server_message', '강화 고정의 주사위는 자신을 지목할 수 없습니다. 유효한 대상을 선택해주세요.');
                    player.inventory.push(diceType); 
                    return;
                }
                if (typeof targetPlayer.lastDiceRollPosition === 'number' && targetPlayer.position !== targetPlayer.lastDiceRollPosition) { 
                    const en_oldFixedPos = targetPlayer.position;
                    const en_fixedPos = targetPlayer.lastDiceRollPosition; 
                    const en_fixedMoveRoll = en_fixedPos - en_oldFixedPos; 
                    const { newPosition: en_f_newPos, isWin: en_f_isWin } = updatePlayerPositionAndCheckWin(roomId, targetPlayer, en_oldFixedPos, en_fixedMoveRoll, true); 
                    io.to(roomId).emit('server_message', `${player.name}님이 강화 고정의 주사위로 ${targetPlayer.name}님을 이전 위치로 돌려보냈습니다.`);
                    if(targetPlayer.isProtect === true){
                        io.to(roomId).emit('server_message', `${targetPlayer.name}님의 보호의 주사위 면역! (강화 고정의 주사위)`);
                    }
                    if (en_f_isWin) {
                        io.to(roomId).emit('game_ended', { winnerId: targetPlayer.id, winnerName: targetPlayer.name });
                        resetRoomAndPlayersForNewGame(roomId);
                    } else {
                        executeBoardEvent(roomId, targetPlayer);
                    }
                } 
                else {
                    io.to(socket.id).emit('server_message', `${targetPlayer.name}님의 이전 위치가 없거나 현재 위치와 동일하여 강화 고정 주사위를 사용할 수 없습니다.`);
                    player.inventory.push(diceType);   
                }
                if (player.isSavingActive) {
                    player.savingStack += 1;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                if (player.e_isSavingActive) {
                    
                    player.e_savingStack += 2;
                    //io.to(roomId).emit('server_message', `${player.name}님의 스택에 ${1}이 추가되었습니다. (현재 스택: ${player.savingStack})`);
                }
                break;

            case '강화 저장의 주사위':
                if (player.e_isSavingActive && player.isSavingActive) {
                    io.to(socket.id).emit('server_message', '저장 주사위는 이미 활성화되어 있습니다.');
                    player.inventory.push(diceType); 
                    return;
                }
                player.e_isSavingActive = true;
                player.e_savingStack = 0;
                player.inventory.push('강화 저장 주사위 스택 받기'); 
                io.to(roomId).emit('server_message', `${player.name}님 강화 저장의 주사의 사용, 저장 시작!`);
                break;

            case '강화 저장 주사위 스택 받기':
                if (!player.e_isSavingActive) {
                    io.to(socket.id).emit('server_message', '저장 모드가 활성화되어 있지 않습니다.');
                    player.inventory.push(diceType); 
                    return;
                }
                const e_stackMove = player.e_savingStack;
                const e_oldSavePos = player.position;
                const { newPosition: e_s_newPos, isWin: e_s_isWin } = updatePlayerPositionAndCheckWin(roomId, player, e_oldSavePos, e_stackMove, true);
                
                io.to(roomId).emit('server_message', `${player.name}님이 강화 저장 주사위 스택 받기로 ${e_stackMove}칸 이동했습니다!`);
                player.e_isSavingActive = false;
                player.e_savingStack = 0;

                if (e_s_isWin) {
                    io.to(roomId).emit('game_ended', { winnerId: player.id, winnerName: player.name });
                    resetRoomAndPlayersForNewGame(roomId);
                } else {
                    executeBoardEvent(roomId, player);
                }
                break;

            
            default:
                io.to(socket.id).emit('server_message', `아직 구현되지 않은 아이템 주사위(${diceType})입니다.`);
                player.inventory.push(diceType); 
                break;
        }

        emitPlayerListUpdate(roomId);
    });


    socket.on('chat message', (msg) => {
        const playerId = socketIdMap[socket.id];
        if (!playerId || !playersData[playerId]) {
            io.to(socket.id).emit('chat_message', `[알림] 플레이어 정보가 유효하지 않습니다. 다시 로그인해주세요.`);
            return;
        }
        
        const roomId = playersData[playerId].currentRoomId;
        if (roomId) {
            io.to(roomId).emit('chat_message', `${playersData[playerId].name}: ${msg}`); 
        } else {
            io.to(socket.id).emit('chat_message', `[알림] 방에 접속해야 채팅을 할 수 있습니다.`); 
        }
    });

    socket.on('select_dice_choice', (data) => {
        const playerId = socketIdMap[socket.id];
        if (!playerId || !playersData[playerId]) {
             io.to(socket.id).emit('server_message', '주사위 선택 실패: 플레이어 정보 없음.');
            return;
        }
        io.to(socket.id).emit('use_item_dice', {
            diceType: 'select_dice_choice',
            selectedDice: data.selectedDice,
            targetPlayerId: playerId 
        });
    });


    socket.on('send_server_message', (message) => { 
        io.emit('server_log', message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[서버 시작] 주사위 대전 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
    console.log(`웹 브라우저에서 이 주소로 접속해주세요.`);
});