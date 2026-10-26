import type { App } from './app';
import { ImgButton, image } from './dom';
import { Dialog, FieldDialog, MessageDialog, Screen } from './screen';

const NAME_KEY = 'graphwar.name';
const loadName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
export const saveName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private mode */ } };

export class MenuScreen extends Screen {
  private msg: MessageDialog;
  private joinGlobal: FieldDialog;
  private create: FieldDialog;
  private joinGame: FieldDialog;

  constructor(private app: App) {
    super(app.stage);
    const r = this.root;
    image(r, 'backMain.png', 33, 90);
    new ImgButton(r, 'joinGlobal.png', 'joinGlobalOver.png', 15, 400, () => this.open(this.joinGlobal), 'Join the online lobby');
    new ImgButton(r, 'createGame.png', 'createGameOver.png', 275, 400, () => this.open(this.create), 'Create a game on this device');
    new ImgButton(r, 'joinGame.png', 'joinGameOver.png', 535, 400, () => this.open(this.joinGame), 'Join a game with a room code');

    this.msg = new MessageDialog(r);

    this.joinGlobal = new FieldDialog(r, { bg: 'backAddPlayer.png', yesImg: ['join.png', 'joinOver.png'], onYes: () => this.doJoinGlobal() });
    this.create = new FieldDialog(r, { bg: 'backAddPlayer.png', yesImg: ['create.png', 'createOver.png'], onYes: () => this.doCreate() });
    this.joinGame = new FieldDialog(r, {
      bg: 'backRoomCode.png', second: true, secondMax: 12, yesImg: ['join.png', 'joinOver.png'], onYes: () => this.doJoinGame(),
    });
    // make the dialog backgrounds that FieldDialog added non-interactive but keep fields clickable (done in FieldDialog)
    for (const d of [this.joinGlobal, this.create, this.joinGame]) Dialog.interactive(d.group.querySelector('input')!);
  }

  private open(d: FieldDialog) {
    for (const x of [this.joinGlobal, this.create, this.joinGame]) x.show(false);
    if (!d.name.value) d.name.value = loadName();
    d.open_();
  }

  private nameOf(d: FieldDialog): string | null {
    const n = d.name.value.trim();
    if (!n) { d.name.focus(); return null; }
    saveName(n);
    return n;
  }

  private doCreate() {
    const n = this.nameOf(this.create);
    if (!n) return;
    this.create.show(false);
    this.app.startLocal(n);
  }

  private doJoinGlobal() {
    const n = this.nameOf(this.joinGlobal);
    if (!n) return;
    if (!this.app.net) { this.joinGlobal.show(false); this.msg.open_('Online play is not configured.'); return; }
    this.joinGlobal.show(false);
    this.msg.open_('Connecting…');
    this.app.lobby.enter(n).then(
      () => { this.msg.show(false); this.app.show('lobby'); },
      (e: Error) => this.msg.open_(`Could not connect. ${e.message}`.slice(0, 60)),
    );
  }

  private doJoinGame() {
    const n = this.nameOf(this.joinGame);
    const code = this.joinGame.second!.value.trim().toUpperCase();
    if (!n) return;
    if (!this.app.net) { this.joinGame.show(false); this.msg.open_('Online play is not configured.'); return; }
    if (!code) { this.joinGame.second!.focus(); return; }
    this.joinGame.show(false);
    this.msg.open_('Connecting…');
    this.app.joinOnline(code, n).then(
      () => this.msg.show(false),
      (e: Error) => this.msg.open_(e.message.slice(0, 60)),
    );
  }
}
