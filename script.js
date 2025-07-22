// Socket.IO 서버에 연결
const socket = io('http://localhost:3000', {
    reconnectionAttempts: 10, 
    reconnectionDelay: 1000,  
    reconnectionDelayMax: 5000 
});

// --- SPA 라우팅 요소 ---
const loginPage = document.getElementById('login-page');
const roomListPage = document.getElementById('room-list-page');
const gameBoardPage = document.getElementById('game-board-page');
const pageContainers = [loginPage, roomListPage, gameBoardPage]; 

function showPage(pageId) {
    pageContainers.forEach(page => {
        page.style.display = 'none'; 
    });
    document.getElementById(pageId).style.display = 'flex'; 
    
    if (gameMessages) { 
        gameMessages.innerHTML = '<p>[로그] 환영합니다! 게임을 시작하세요.</p>';
    }
}


// --- 전역 변수 ---
const googleLoginButton = document.getElementById('google-login-button');
const playerNicknameSpan = document.getElementById('player-nickname');
const logoutButton = document.getElementById('logout-button');
const createRoomButton = document.getElementById('create-room-button');
const roomListDiv = document.getElementById('room-list');
const noRoomsMessage = document.getElementById('no-rooms-message');
const currentRoomNameSpan = document.getElementById('current-room-name');
const playerNameSpan = document.getElementById('player-name');
const leaveRoomButton = document.getElementById('leave-room-button');
const rollDiceButton = document.getElementById('roll-dice-button');
const diceResultDisplay = document.getElementById('dice-result');
const gameMessages = document.getElementById('game-messages'); 
const readyButton = document.getElementById('ready-button');
const startGameButton = document.getElementById('start-game-button');
const playerListDiv = document.getElementById('player-list');
const itemDiceInventory = document.getElementById('item-dice-inventory');
const boardCells = document.querySelectorAll('.board-cell'); 
const sortedBoardCells = Array.from(boardCells).sort((a, b) => {
    return parseInt(a.dataset.cellIndex) - parseInt(b.dataset.cellIndex);
});
const chatInput = document.getElementById('chat-input');
const chatSendButton = document.getElementById('chat-send-button');
const diceSelectionPopup = document.getElementById('dice-selection-popup');
const diceSelectionList = document.getElementById('dice-selection-list');
const cancelDiceSelectionButton = document.getElementById('cancel-dice-selection');
const explanationButton = document.getElementById('explanation-button');


let currentPlayerId = null; 
let currentPlayerName = null; 
let currentRoomId = null;
let currentRoomName = null;
let currentPlayerRole = null; 

let playersInRoom = []; 
let gameStarted = false; 


const diceColors = {
    '운명의 주사위': '#ffffff', '플러스의 주사위': '#364beb', '마이너스의 주사위': '#0c6633', '보호의 주사위': '#f0f005', '저주의 주사위': '#f00505', '확률의 주사위': '#e0be41', '무작위의 주사위': '#9e9b8e', '벌칙의 주사위': '#e262f0', '강화의 주사위': '#0d1770', '저장의 주사위': '#30d9ac', '고정의 주사위': '#d9305d',
    '강화 운명의 주사위': '#ffffff', '강화 플러스의 주사위': '#364beb', '강화 마이너스의 주사위': '#0c6633', '강화 저주의 주사위': '#F44336', '강화 보호의 주사위': '#f0f005', '강화 무작위의 주사위': '#9e9b8e', '강화 벌칙의 주사위': '#e262f0', '강화 확률의 주사위': '#e0be41', '강화 고정의 주사위': '#d9305d', '강화 저장의 주사위': '#30d9ac', 
    '저장 주사위 스택 받기': '#36330fff', '강화 저장 주사위 스택 받기': '#36330fff', 
};
const targetingDice = ['마이너스의 주사위', '저주의 주사위', '벌칙의 주사위', '고정의 주사위', '강화 플러스의 주사위', '강화 마이너스의 주사위', '강화 저주의 주사위', '강화 보호의 주사위', '강화 벌칙의 주사위', '강화 고정의 주사위', '강화 보호의 주사위'];

// --- 메시지 출력 함수 ---
function addGameMessage(message) {
    if (gameMessages) { 
        const p = document.createElement('p');
        p.textContent = message;
        gameMessages.appendChild(p);
        gameMessages.scrollTop = gameMessages.scrollHeight; 
    } else {
        console.log(message);
    }
}

// --- 플레이어 목록 업데이트 및 렌더링 ---
function updatePlayerList() {
    playerListDiv.innerHTML = ''; 

    playersInRoom.forEach(player => {
        const playerItem = document.createElement('div');
        playerItem.classList.add('player-item');
        if (player.id === currentPlayerId) { 
            playerItem.classList.add('player-self');
            currentPlayerRole = player.role;
        }
        if (player.role === 'host') {
            playerItem.innerHTML = `<span class="player-icon host-icon">👑</span> `;
        } else {
            playerItem.innerHTML = `<span class="player-icon"></span> `;
        }
        playerItem.innerHTML += `${player.name} (${player.status}) <span class="player-token" style="background-color: ${player.color};"></span>`;
        playerListDiv.appendChild(playerItem);
    });
    setupRoleUI();
}

// --- 플레이어 말 (토큰) 보드에 표시 ---
function renderPlayerTokens() {
    document.querySelectorAll('.player-token-on-board').forEach(token => token.remove());

    playersInRoom.forEach(player => {
        const cell = sortedBoardCells[player.position];
        if (cell) {
            const token = document.createElement('div');
            token.classList.add('player-token-on-board');
            token.dataset.playerId = player.id;
            token.style.backgroundColor = player.color;
            
            const playersOnThisCell = playersInRoom.filter(p => p.position === player.position);
            const playerIndexOnCell = playersOnThisCell.findIndex(p => p.id === player.id);
            const angleOffset = 360 / playersOnThisCell.length;
            const angle = playerIndexOnCell * angleOffset;
            const radius = playersOnThisCell.length > 1 ? 10 : 0; 
            const xOffset = radius * Math.cos(angle * Math.PI / 180);
            const yOffset = radius * Math.sin(angle * Math.PI / 180);
            
            token.style.transform = `translate(calc(-50% + ${xOffset}px), calc(-50% + ${yOffset}px))`;
            token.style.left = '50%';
            token.style.top = '50%';

                    // 📌 상태이상 UI 추가
            if (player.statusEffects?.jail) {
                const statusIcon = document.createElement('div');
                statusIcon.classList.add('status-icon');
                statusIcon.innerText = '🏝'; // 무인도
                token.appendChild(statusIcon);
            }

            if (player.statusEffects?.punished) {
                const statusIcon = document.createElement('div');
                statusIcon.classList.add('status-icon');
                statusIcon.innerText = '⚠️'; // 벌칙
                token.appendChild(statusIcon);
            }
            
            cell.appendChild(token);
        }
    });
}

// --- 보드 칸 이벤트 렌더링 ---
let currentBoardEvents = [];
function renderBoardEvents(events) {
    currentBoardEvents = events;

    sortedBoardCells.forEach((cell, index) => {
        if (index !== 0 && index !== 24) { 
            cell.innerHTML = ''; 
            cell.className = 'board-cell'; 
        }
    });
    
    events.forEach((event, index) => {
        const boardCellIndex = index + 1; 
        const cell = sortedBoardCells[boardCellIndex];

        if (boardCellIndex === 24) {
            cell.className = 'board-cell special-jail'; 
            cell.innerHTML = '무인도';
            return;
        }

        if (cell) {
            if (event.type === 'get_dice') {
                let displayName = event.value;
                if (displayName.startsWith('강화 ')) {
                    displayName = displayName.replace('강화 ', '강화<br>').replace('의 주사위', '');
                } else {
                    displayName = displayName.replace('의 주사위', '');
                }
                cell.innerHTML = `<br>${displayName}`; 
                cell.classList.add('event-get-dice'); 
            } else if (event.type === 'event') {
                if (event.effect && event.effect.type === 'empty') {
                    cell.innerHTML = ''; 
                } else {
                    cell.innerHTML = event.name; 
                    cell.classList.add('event-special'); 
                }
            }
        }
    });
}

// --- 주사위 아이템 인벤토리 렌더링 ---
function renderItemDiceInventory(inventory) {
    itemDiceInventory.innerHTML = '';
    if (!Array.isArray(inventory) || inventory.length === 0) {
        itemDiceInventory.innerHTML = '<p>아이템 주사위가 없습니다.</p>';
        return;
    }
    inventory.forEach(diceName => {
        const button = document.createElement('button');
        button.classList.add('item-dice-btn');
        button.dataset.dice = diceName;
        let displayName = diceName;
        if (displayName.startsWith('강화 ')) {
            displayName = displayName.replace('강화 ', '강화<br>');
        }
        button.innerHTML = `<span class="dice-color-preview" style="background-color: ${diceColors[diceName] || '#cccccc'};"></span> ${displayName}`;
        button.addEventListener('click', handleItemDiceUse);
        itemDiceInventory.appendChild(button);
    });
}

// --- 주사위 아이템 사용 이벤트 핸들러 ---
function handleItemDiceUse(event) {
    const diceType = event.target.closest('.item-dice-btn').dataset.dice;
    addGameMessage(`[액션] ${diceType} 주사위를 사용 시도합니다.`);

    if (targetingDice.includes(diceType)) {
        showTargetSelection(diceType);
    } else {
        socket.emit('use_item_dice', { diceType: diceType, targetPlayerId: null });
    }
}

// --- 대상 선택 팝업 관련 ---
let targetSelectionPopup = null;
let currentDiceForTargeting = null;

function showTargetSelection(diceType) {
    currentDiceForTargeting = diceType;
    if (targetSelectionPopup) {
        targetSelectionPopup.remove();
    }

    targetSelectionPopup = document.createElement('div');
    targetSelectionPopup.classList.add('target-selection-popup');
    targetSelectionPopup.innerHTML = `
        <h3>${diceType} 대상 선택</h3>
        <div class="player-selection-list"></div>
        <button class="btn cancel-target-selection">취소</button>
    `;

    const playerSelectionList = targetSelectionPopup.querySelector('.player-selection-list');
    
    let selectablePlayers = playersInRoom.filter(player => player.id !== currentPlayerId); 

    // if (diceType === '보호의 주사위') {
    //     selectablePlayers = playersInRoom.filter(player => player.id === currentPlayerId);
    // }

    selectablePlayers.forEach(player => {
        const playerEntry = document.createElement('div');
        playerEntry.classList.add('player-selection-item');
        playerEntry.dataset.playerId = player.id;
        playerEntry.innerHTML = `
            <span class="player-token" style="background-color: ${player.color};"></span>
            <span>${player.name} (${player.status})</span>
        `;
        playerEntry.addEventListener('click', () => selectTargetPlayer(player.id));
        playerSelectionList.appendChild(playerEntry);
    });

    if (playerSelectionList.children.length === 0) {
        playerSelectionList.innerHTML = '<p>현재 지목할 다른 플레이어가 없습니다.</p>';
        targetSelectionPopup.querySelector('.cancel-target-selection').textContent = '확인';
    }


    document.body.appendChild(targetSelectionPopup);

    targetSelectionPopup.style.left = '50%';
    targetSelectionPopup.style.top = '50%';
    targetSelectionPopup.style.transform = 'translate(-50%, -50%)';

    targetSelectionPopup.querySelector('.cancel-target-selection').addEventListener('click', hideTargetSelection);
}

function selectTargetPlayer(targetPlayerId) {
    if (!currentDiceForTargeting) return;
    socket.emit('use_item_dice', { diceType: currentDiceForTargeting, targetPlayerId: targetPlayerId });
    hideTargetSelection();
}

function hideTargetSelection() {
    if (targetSelectionPopup) {
        targetSelectionPopup.remove();
        targetSelectionPopup = null;
        currentDiceForTargeting = null;
    }
}


// --- 역할 기반 UI 제어 ---
function setupRoleUI() {
    const self = playersInRoom.find(p => p.id === currentPlayerId);

    if (currentPlayerRole === 'host') {
        readyButton.textContent = '방장입니다 (준비 필요 없음)';
        readyButton.disabled = true;
        startGameButton.style.display = 'block';
        startGameButton.disabled = true;
        if (!gameStarted) {
            // addGameMessage(`[SYSTEM] ${currentPlayerName}님은 방장입니다. 다른 플레이어들이 준비되기를 기다려주세요.`);
        }
    } else {
        readyButton.style.display = 'block';
        readyButton.disabled = false;
        if (self && self.status === '준비') {
            readyButton.textContent = '준비 취소';
        } else {
            readyButton.textContent = '준비';
        }
        startGameButton.style.display = 'none';
        if (!gameStarted) {
            // addGameMessage(`[SYSTEM] ${currentPlayerName}님은 일반 플레이어입니다. 준비 버튼을 눌러주세요.`);
        }
    }

    if (gameStarted) {
        readyButton.style.display = 'none';
        startGameButton.style.display = 'none';
    } else {
        if (currentPlayerRole === 'host') {
             startGameButton.style.display = 'block';
             readyButton.style.display = 'none';
        } else {
             startGameButton.style.display = 'none';
             readyButton.style.display = 'block';
        }
    }
}


// --- Socket.IO 이벤트 리스너 ---

// DOMContentLoaded 시점: Socket.IO 연결 설정 이전에 플레이어 ID/이름을 확보하고 UI 초기 상태 설정
document.addEventListener('DOMContentLoaded', () => {
    // localStorage에서 playerId 로드. 없으면 새로 생성하여 localStorage에 저장 (한 번만)
    if (!sessionStorage.getItem('playerId')) {
        sessionStorage.setItem('playerId', `player_${Math.random().toString(36).substr(2, 9)}`);
    }
    currentPlayerId = sessionStorage.getItem('playerId');

    // playerName은 세션 동안만 유효하므로, 없으면 새로 생성 (로그인 버튼 클릭 시 새 이름 부여)
    if (!sessionStorage.getItem('playerName')) {
        sessionStorage.setItem('playerName', `기본용사_${Math.floor(Math.random() * 1000)}`); // 기본값
    }
    currentPlayerName = sessionStorage.getItem('playerName'); // 세션 스토리지에서 로드

    // 현재 방 정보 (세션 스토리지에서 가져옴)
    currentRoomId = sessionStorage.getItem('currentRoomId');
    currentRoomName = sessionStorage.getItem('currentRoomName');
    currentPlayerRole = sessionStorage.getItem('playerRole');

    // 초기에는 무조건 로그인 페이지부터 시작하고, 나머지 페이지는 숨김
    showPage('login-page'); 

    // 로그인 화면의 닉네임 표시
    playerNicknameSpan.textContent = currentPlayerName; // 방 목록에도
    playerNameSpan.textContent = currentPlayerName; // 게임 화면에도
});


// 서버와 연결되었을 때 (재연결 시에도 호출됨)
socket.on('connect', () => {
    console.log('클라이언트: 서버에 연결되었습니다.', socket.id);
    // 연결되자마자 서버에 자신의 playerId와 playerName을 전송 (서버가 플레이어를 인지하도록)
    socket.emit('set_player_info', { 
        playerId: currentPlayerId, 
        playerName: currentPlayerName // 현재 클라이언트가 가진 닉네임을 보냄
    });
});

// 서버로부터 플레이어 정보 설정 완료 확인 메시지 (player_info_set_ack 수신 시 비로소 UI 라우팅 시작)
socket.on('player_info_set_ack', (data) => { 
    console.log(`클라이언트: 서버가 플레이어 정보 설정을 확인했습니다.`);
    // 서버로부터 받은 최신 정보로 클라이언트 상태 동기화
    currentPlayerId = data.playerId; 
    currentPlayerName = data.playerName; 
    currentRoomId = data.currentRoomId;
    currentRoomName = data.currentRoomName;
    currentPlayerRole = data.playerRole;

    // localStorage 및 sessionStorage를 서버에서 받은 최신 정보로 업데이트
    localStorage.setItem('playerId', currentPlayerId); 
    sessionStorage.setItem('playerName', currentPlayerName); 
    sessionStorage.setItem('playerRole', currentPlayerRole); 
    if (currentRoomId) {
        sessionStorage.setItem('currentRoomId', currentRoomId);
        sessionStorage.setItem('currentRoomName', currentRoomName);
    } else {
        sessionStorage.removeItem('currentRoomId');
        sessionStorage.removeItem('currentRoomName');
    }

    // 모든 페이지에 현재 닉네임 표시
    playerNicknameSpan.textContent = currentPlayerName;
    playerNameSpan.textContent = currentPlayerName;

    // 이제 player_info_set_ack를 받았으므로, 안전하게 UI 라우팅 시작
    if (currentRoomId) { // 게임방에 접속 중이었다면 바로 게임방으로
        showPage('game-board-page');
        currentRoomNameSpan.textContent = `🎲 ${currentRoomName} 🎲`;
        addGameMessage(`[SYSTEM] ${currentRoomName}방에 오신 것을 환영합니다!`);
    } else if (sessionStorage.getItem('isLoggedIn') === 'true') { // 로그인 버튼을 눌러 'isLoggedIn'이 true인 경우
        showPage('room-list-page');
        socket.emit('request_room_list'); // 방 목록 요청
    } else { // 로그인하지 않은 상태
        showPage('login-page');
    }
});


// 서버로부터 플레이어 목록 업데이트 받기
socket.on('player_list_update', (players) => {
    playersInRoom = players;
    updatePlayerList(); 
    renderPlayerTokens(); 
    
    const self = playersInRoom.find(p => p.id === currentPlayerId);
    if (self) {
        renderItemDiceInventory(self.inventory || []); 
    }

    if (currentPlayerRole === 'host' && !gameStarted) {
         const allReady = playersInRoom.every(p => p.status === '준비' || p.role === 'host');
         const minPlayersMet = playersInRoom.length >= 2;
         startGameButton.disabled = !(allReady && minPlayersMet); 
    }
});

// 서버로부터 게임 상태 업데이트 받기 (예: 게임 시작 가능 여부)
socket.on('game_state_update', (data) => {
    if (data.canStart && currentPlayerRole === 'host') {
        startGameButton.disabled = false;
    } else if (!data.canStart && currentPlayerRole === 'host') {
        startGameButton.disabled = true;
    }
});

// 서버 메시지 받기 (채팅이나 시스템 메시지)
socket.on('server_message', (msg) => {
    addGameMessage(`[서버] ${msg}`);
});
// 일반 채팅 메시지 받기
socket.on('chat_message', (msg) => {
    addGameMessage(`[채팅] ${msg}`);
});

// 서버 로그 메시지 받아서 게임 메시지에 추가
socket.on('server_log', (msg) => {
    addGameMessage(`[서버 로그] ${msg}`);
});

// --- 이벤트 리스너 ---

// 로그인 버튼
googleLoginButton.addEventListener('click', () => {
    sessionStorage.setItem('isLoggedIn', 'true'); // 로그인했음을 명시적으로 표시
    // 기존 playerId는 유지하고, 새로운 playerName만 생성
    const newPlayerName = `용사_${Math.floor(Math.random() * 1000)}`; 
    sessionStorage.setItem('playerName', newPlayerName); 

    // 전역 변수 업데이트
    currentPlayerName = newPlayerName; 
    sessionStorage.setItem('playerRole', 'guest'); // 로그인 시 역할은 guest로 초기화
    currentPlayerRole = 'guest';

    // 서버에 플레이어 정보 설정 (playerId는 'connect'에서 이미 전송됨)
    // 여기서는 playerName만 업데이트하여 서버에 다시 알림
    socket.emit('set_player_info', { playerId: currentPlayerId, playerName: currentPlayerName });

    // UI는 player_info_set_ack를 받은 후에 동기화되므로, 이 시점에서는 요청만 보냄
    // 여기서는 화면 전환 없이, set_player_info_ack를 기다려야 정확한 라우팅이 일어남
});


// 로그아웃 버튼
logoutButton.addEventListener('click', () => {
    socket.disconnect(); // 서버와의 연결 끊기
    sessionStorage.clear(); // 세션 스토리지 비움 (현재 닉네임, 방 정보, isLoggedIn 등 삭제)
    localStorage.removeItem('playerId'); // 로그아웃 시 playerId도 삭제 (완전한 초기화)

    alert('로그아웃 되었습니다. 다른 닉네임으로 다시 로그인해주세요.');
    
    // 전역 변수들 초기화
    currentPlayerId = null; 
    currentPlayerName = null;
    currentRoomId = null;
    currentRoomName = null;
    currentPlayerRole = null;
    
    // UI 초기화 및 로그인 페이지로 전환
    showPage('login-page'); 
    // 기본값으로 닉네임 설정 (로그인 전 화면에 표시될 임시 닉네임)
    const tempName = `임시용사_${Math.floor(Math.random() * 1000)}`;
    playerNicknameSpan.textContent = tempName;
    playerNameSpan.textContent = tempName;
    sessionStorage.setItem('playerName', tempName); // 세션 스토리지도 업데이트
    sessionStorage.setItem('isLoggedIn', 'false'); // 로그인되지 않은 상태
});


// 새 방 만들기 버튼
createRoomButton.addEventListener('click', () => {
    const roomName = prompt('만들 방 이름을 입력해주세요:');
    if (roomName && roomName.trim() !== '') {
        socket.emit('create_room', { roomName: roomName.trim() });
    } else if (roomName !== null) {
        alert('방 이름을 입력해야 합니다.');
    }
});


// 방 참가 버튼 (이벤트 위임)
roomListDiv.addEventListener('click', (event) => {
    const joinButton = event.target.closest('.join-room-btn');
    if (joinButton && !joinButton.disabled) {
        const roomItem = joinButton.closest('.room-item');
        const roomId = roomItem.dataset.roomId;
        socket.emit('join_room', { roomId: roomId });
    }
});


// 방 생성 성공 시
socket.on('room_created_success', (data) => {
    console.log(`방 생성 성공: ${data.roomName}`);
    sessionStorage.setItem('currentRoomId', data.roomId);
    sessionStorage.setItem('currentRoomName', data.roomName);
    sessionStorage.setItem('playerRole', 'host');
    currentRoomId = data.roomId;
    currentRoomName = data.roomName;
    currentPlayerRole = 'host';
    socket.emit('request_player_list');
    showPage('game-board-page'); 
    currentRoomNameSpan.textContent = `🎲 ${currentRoomName} 🎲`; 
    playerNameSpan.textContent = currentPlayerName; 
    addGameMessage(`[SYSTEM] 🎲 주사위 대전 ${currentRoomName}방에 오신 것을 환영합니다!`);
});

socket.on('request_player_list', () => {
    const playerId = socketIdMap[socket.id];
    if (!playerId || !playersData[playerId]) return;

    const roomId = playersData[playerId].currentRoomId;
    if (roomId) {
        emitPlayerListUpdate(roomId);
    }
});

socket.on('room_list_update', (rooms) => {
    roomListDiv.innerHTML = ''; // 기존 방 목록 비우기

    if (rooms.length === 0) {
        noRoomsMessage.style.display = 'block';
        return;
    } else {
        noRoomsMessage.style.display = 'none';
    }

    rooms.forEach(room => {
        const roomItem = document.createElement('div');
        roomItem.classList.add('room-item');
        roomItem.dataset.roomId = room.id;

        roomItem.innerHTML = `
            <span class="room-name">${room.name}</span>
            <span class="room-status">👥 ${room.playersCount}/${room.maxPlayers}</span>
            <button class="join-room-btn">입장</button>
        `;

        roomListDiv.appendChild(roomItem);
    });
});


// 방 참가 성공 시
socket.on('room_joined_success', (data) => {
    console.log(`방 참가 성공: ${data.roomName}`);
    sessionStorage.setItem('currentRoomId', data.roomId);
    sessionStorage.setItem('currentRoomName', data.roomName);
    sessionStorage.setItem('playerRole', 'player');
    currentRoomId = data.roomId;
    currentRoomName = data.roomName;
    currentPlayerRole = 'player';

    showPage('game-board-page'); 
    currentRoomNameSpan.textContent = `🎲 ${currentRoomName} 🎲`; 
    playerNameSpan.textContent = currentPlayerName; 
    addGameMessage(`[SYSTEM] 🎲 주사위 대전 ${currentRoomName}방에 오신 것을 환영합니다!`);
});

// 방 참가 실패 시
socket.on('room_join_failed', (message) => {
    alert(`방 참가 실패: ${message}`);
});


// 방 나가기 버튼
leaveRoomButton.addEventListener('click', () => {
    socket.emit('leave_room');
});

// 방 나가기 성공 시
socket.on('left_room_success', () => {
    sessionStorage.removeItem('currentRoomId');
    sessionStorage.removeItem('currentRoomName');
    sessionStorage.removeItem('playerRole');
    currentRoomId = null;
    currentRoomName = null;
    currentPlayerRole = null;

    showPage('room-list-page'); 
    playerNicknameSpan.textContent = currentPlayerName; 
    socket.emit('request_room_list'); 
});


// 준비 버튼 (일반 플레이어)
readyButton.addEventListener('click', () => {
    socket.emit('player_ready');
});


// 게임 시작 버튼 (방장만)
startGameButton.addEventListener('click', () => {
    if (currentPlayerRole === 'host') {
        socket.emit('start_game');
    } else {
        addGameMessage('[오류] 게임 시작은 방장만 할 수 있습니다.');
    }
});


// 운명의 주사위 굴리기 버튼
rollDiceButton.addEventListener('click', () => {
    if (!gameStarted) {
        addGameMessage('[오류] 게임이 시작되지 않았습니다.');
        return;
    }
    socket.emit('roll_dice');
});


// 주사위 굴림 결과 받기
socket.on('dice_roll_result', (data) => {
    diceResultDisplay.textContent = data.roll;
    addGameMessage(`[결과] ${data.playerName}님이 주사위 ${data.roll}을 굴렸습니다!`);
    
    const playerToMove = playersInRoom.find(p => p.id === data.playerId);
    if (playerToMove) {
        playerToMove.position = data.newPosition;
        renderPlayerTokens();
    }
});


// 보드 이벤트 업데이트 (게임 시작 시 서버로부터 받음)
socket.on('board_events_update', (assignedEvents) => {
    renderBoardEvents(assignedEvents);
});


// 플레이어가 칸에 도착하여 이벤트 발동 시 메시지
socket.on('player_landed_on_event', (data) => {
    addGameMessage(`[이벤트] ${data.message}`);
});


// 이벤트에 의한 플레이어 강제 이동
socket.on('player_moved_by_event', (data) => {
    addGameMessage(`[이벤트 이동] ${data.message}`);
});


// 게임 시작 관련 시스템 메시지 (카운트다운 등)
socket.on('game_start_countdown', (countdown) => {
    addGameMessage(`[SYSTEM] 게임이 ${countdown}초 후에 시작됩니다!`);
});


// 게임 시작
socket.on('game_started', () => {
    addGameMessage('[SYSTEM] 게임이 시작되었습니다!');
    gameStarted = true;
    readyButton.style.display = 'none';
    startGameButton.style.display = 'none';
});


// 게임 종료
socket.on('game_ended', (data) => {
    addGameMessage(`[승리] ${data.winnerName}님이 승리했습니다!`);
    
    alert(`${data.winnerName}님이 승리했습니다!\n게임이 재설정됩니다.`);
    gameStarted = false;
    rollDiceButton.disabled = true;
    setupRoleUI();
    renderBoardEvents([]); // 보드 이벤트도 초기 상태로 (클라이언트 측에서 빈 배열 받으면 비워짐)
});


// 턴 업데이트
socket.on('turn_update', (data) => {
    addGameMessage(`[SYSTEM] ${data.currentPlayerName}님의 턴입니다!`);
    if (currentPlayerId === data.currentPlayerId) {
        rollDiceButton.disabled = false;
        addGameMessage('[SYSTEM] 주사위를 굴려주세요.');
    }
});


// --- 채팅 기능 ---
chatSendButton.addEventListener('click', () => {
    const message = chatInput.value.trim();
    if (message) {
        socket.emit('chat message', message);
        chatInput.value = '';
    }
});

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        chatSendButton.click();
    }
});
// --- 채팅 기능 끝 ---

// script.js - socket.on('player_healed')로 받아서 표현
socket.on('player_healed', (playerId) => {
  const token = document.getElementById(`player-token-${playerId}`);
  token.classList.add('healed');
  setTimeout(() => token.classList.remove('healed'), 1000);
});


// --- 원하는 주사위 선택 팝업 (player_landed_on_event의 get_any_dice에서 발생) ---
socket.on('request_dice_selection', (data) => {
    // --- 수정 시작: 팝업 요소들을 직접 사용하여 UI 동작 구현 ---
    diceSelectionPopup.style.display = 'flex'; // 팝업 보이기
    diceSelectionList.innerHTML = ''; // 기존 선택지 초기화

    data.availableDice.forEach(diceName => {
        const button = document.createElement('button');
        button.classList.add('item-dice-btn'); // 기존 아이템 주사위 버튼 스타일 재활용
        
        let displayName = diceName;
        // '저장 주사위 스택 받기'의 display 이름을 UI에 맞게 변경
        if (displayName === '저장 주사위 스택 받기') {
            displayName = '저장 스택<br>받기'; 
        } else if (displayName.startsWith('강화 ')) {
            displayName = displayName.replace('강화 ', '강화<br>');
        }

        button.innerHTML = `<span class="dice-color-preview" style="background-color: ${diceColors[diceName] || '#cccccc'};"></span> ${displayName}`; // diceColors의 키는 전체 이름
        
        button.addEventListener('click', () => {
            socket.emit('select_dice_choice', { selectedDice: diceName });
            diceSelectionPopup.style.display = 'none'; // 선택 후 팝업 닫기
        });
        diceSelectionList.appendChild(button);
    });

    // 취소 버튼 이벤트 리스너 (한 번만 등록되도록 'once' 옵션 사용)
    cancelDiceSelectionButton.addEventListener('click', () => {
        diceSelectionPopup.style.display = 'none'; // 취소 후 팝업 닫기
        socket.emit('select_dice_choice', { selectedDice: null }); // 서버에 null 전달 (선택 취소)
    }, { once: true }); // 이 리스너는 한 번만 실행되면 자동으로 제거됩니다.
});

explanationButton.addEventListener('click', () => {
    // SPA 내 페이지 전환 대신, 완전히 새로운 HTML 페이지로 이동 (사용자 요청)
    window.location.href = 'dice_explanation.html'; 
});

// 서버와의 연결이 끊어졌을 때 (예: 서버 재시작, 네트워크 문제)
socket.on('disconnect', () => {
    addGameMessage('[SYSTEM] 서버와의 연결이 끊어졌습니다. 로비로 돌아갑니다.');
    sessionStorage.clear();
    alert('서버 연결이 끊어져 로비로 이동합니다.');
    showPage('login-page'); 
    
    currentPlayerId = null; 
    currentPlayerName = null;
    currentRoomId = null;
    currentRoomName = null;
    currentPlayerRole = null;
});

// 연결 오류
socket.on('connect_error', (error) => {
    console.error('연결 오류:', error);
    addGameMessage('[SYSTEM] 서버 연결에 실패했습니다. 네트워크 상태를 확인해주세요.');
});