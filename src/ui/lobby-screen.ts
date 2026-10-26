// Port of Graphwar/GlobalScreen.java (+ RoomBoard / GlobalPlayerBoard): the online lobby.
// Layout coordinates come from rsc/GlobalRoom.txt. The original "port" field is gone (browsers cannot listen
// on a port): rooms are created by name and joined from this list or by room code.
import type { App } from './app';
import type { RoomInfo } from '../net/types';
import { ChatBox, ImgButton, el, image, px, textField } from './dom';
import { FieldDialog, MessageDialog, Screen } from './screen';

const MODE_LABEL = ['y', "y'", "y''"];

export class LobbyScreen extends Screen {
  private playersEl: HTMLElement;
  private roomsEl: HTMLElement;
  private chatBox: ChatBox;
  private chatField: HTMLInputElement;
  private gameRoomBtn: ImgButton;
  private create: FieldDialog;
  private msg: MessageDialog;
  private playerName = '';
  private rooms: RoomInfo[] = [];
  private busy = false;

  constructor(private app: App) {
    super(app.stage);
    const r = this.root;
    image(r, 'OnlinePlayers.png', 560, 0);
    image(r, 'CreatedRooms.png', 0, 0);
    image(r, 'Chat.png', 0, 250);
    image(r, 'shadowRooms.png', 0, 35);
    image(r, 'shadowPlayers.png', 570, 35);
    image(r, 'shadowChat.png', 0, 285);
    image(r, 'shadowChatField.png', 0, 550);

    new ImgButton(r, 'create.png', 'createOver.png', 583, 420, () => this.openCreate(), 'Create a room');
    this.gameRoomBtn = new ImgButton(r, 'gameRoom.png', 'gameRoomOver.png', 583, 475, () => this.app.show(this.app.session ? 'pregame' : 'lobby'), 'Back to your room');
    new ImgButton(r, 'back.png', 'backOver.png', 583, 530, () => this.leave(), 'Leave the lobby');

    this.chatField = textField(r, 15, 565, 555, 200);
    this.chatBox = new ChatBox(r, 15, 300, 555, 250);
    this.chatField.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const t = this.chatField.value.trim();
      if (t) this.app.net?.say(t);
      this.chatField.value = '';
    });

    this.roomsEl = px(el('div', 'rooms', r), 15, 50, 400, 200);
    this.playersEl = px(el('div', 'plist', r), 585, 50, 200, 370);

    this.create = new FieldDialog(r, { bg: 'backAddPlayer.png', yesImg: ['create.png', 'createOver.png'], onYes: () => this.doCreate() });
    this.msg = new MessageDialog(r);
    this.renderRooms();
  }

  setShown(v: boolean) {
    super.setShown(v);
    if (v) {
      this.gameRoomBtn.show(!!this.app.session);
      void this.app.net?.refreshRooms();
    }
  }

  /** connects to the lobby; resolves when joined, rejects with a readable error */
  async enter(name: string): Promise<void> {
    const net = this.app.net;
    if (!net) throw new Error('Online play is not configured.');
    this.playerName = name;
    this.chatBox.clear();
    this.rooms = [];
    this.renderRooms();
    await net.join(name, {
      onPlayers: names => this.renderPlayers(names),
      onRooms: rooms => { this.rooms = rooms; this.renderRooms(); },
      onChat: (who, text) => this.chatBox.add(who, null, text),
      onError: m => this.chatBox.add(null, null, m),
    });
    this.chatBox.add(null, null, `Welcome to the Graphwar lobby, ${name}.`);
  }

  private leave() {
    this.app.endSession();
    this.app.net?.leave();
    this.app.show('menu');
  }

  private openCreate() {
    this.create.name.placeholder = 'Room name';
    if (!this.create.name.value) this.create.name.value = `${this.playerName}'s room`.slice(0, 20);
    this.create.open_();
  }

  private doCreate() {
    const roomName = this.create.name.value.trim();
    if (!roomName || this.busy) { this.create.name.focus(); return; }
    this.busy = true;
    this.create.show(false);
    this.msg.open_('Creating…');
    this.app.createOnline(roomName, this.playerName).then(
      () => this.msg.show(false),
      (e: Error) => this.msg.open_(`Failed! ${e.message}`.slice(0, 60)),
    ).finally(() => { this.busy = false; });
  }

  private join(room: RoomInfo) {
    if (this.busy) return;
    if (room.state === 'playing') { this.msg.open_('That game has already started.'); return; }
    if (room.players >= 10) { this.msg.open_('That room is full.'); return; }
    this.busy = true;
    this.msg.open_('Connecting…');
    this.app.joinOnline(room.code, this.playerName).then(
      () => this.msg.show(false),
      (e: Error) => this.msg.open_(e.message.slice(0, 60)),
    ).finally(() => { this.busy = false; });
  }

  private renderPlayers(names: string[]) {
    this.playersEl.textContent = '';
    for (const n of names) {
      const d = el('div', '', this.playersEl);
      d.textContent = n; // textContent: names are other users' input
    }
  }

  private renderRooms() {
    this.roomsEl.textContent = '';
    for (const room of this.rooms) {
      const row = el('div', 'r', this.roomsEl);
      if (room.state === 'playing') row.style.opacity = '0.5';
      const name = el('span', '', row); name.textContent = ` ${room.name}`;
      const n = el('span', 'n', row); n.textContent = `${room.players}/10`;
      const m = el('span', 'm', row); m.textContent = MODE_LABEL[room.mode] ?? 'y';
      row.addEventListener('click', () => this.join(room));
    }
  }
}
