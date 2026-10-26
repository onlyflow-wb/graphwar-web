import { rsc } from './dom';

const FILES = [
  'backMain.png', 'joinGlobal.png', 'joinGlobalOver.png', 'createGame.png', 'createGameOver.png', 'joinGame.png', 'joinGameOver.png',
  'backAddPlayer.png', 'backRoomCode.png', 'backAddCompPlayer.png', 'backMessage.png', 'backQuitConfirm.png', 'shadowFields.png',
  'join.png', 'joinOver.png', 'back.png', 'backOver.png', 'create.png', 'createOver.png', 'add.png', 'addOver.png', 'ok.png', 'okOver.png',
  'yes.png', 'yesOver.png', 'no.png', 'noOver.png',
  'team1.png', 'team2.png', 'shadowChatPreGame.png', 'shadowChatFieldGame.png', 'funcNormal.png', 'funcNormalOver.png', 'funcFst.png',
  'funcFstOver.png', 'funcSnd.png', 'funcSndOver.png', 'addLocalPlayer.png', 'addLocalPlayerOver.png', 'addComputerPlayer.png',
  'addComputerPlayerOver.png', 'readyNormal.png', 'readyOver.png', 'globalRoom.png', 'globalRoomOver.png',
  'arrowLeftBlack.png', 'arrowLeftRed.png', 'arrowLeftGray.png', 'soldierMenu.png', 'soldierMenuOver.png', 'soldierGhost.png',
  'blackX.png', 'redX.png', 'grayX.png',
  'backGame.png', 'shadowFuncField.png', 'shadowChatGame.png', 'backAngle.png', 'timer.png', 'y.png', 'dy.png', 'ddy.png', 'fire.png', 'fireOverRed.png',
  'quit.png', 'quitOver.png',
  'OnlinePlayers.png', 'CreatedRooms.png', 'Chat.png', 'shadowRooms.png', 'shadowPlayers.png', 'shadowChat.png', 'shadowChatField.png',
  'gameRoom.png', 'gameRoomOver.png',
];

export function preloadUi(): Promise<unknown> {
  return Promise.all(FILES.map(f => new Promise<void>(res => {
    const i = new Image();
    i.onload = i.onerror = () => res(); // a missing image must not block start-up
    i.src = rsc(f);
  })));
}
