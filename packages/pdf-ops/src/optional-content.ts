/**
 * 선택적 콘텐츠(/OC) 숨김 판정. MuPDF 1.28 pdf_is_ocg_hidden(usage "View", 기본 구성 /D)과 같은 규칙.
 * - OCG: /OCProperties /OCGs 에 없으면 보임. 있으면 /D 의 BaseState(기본 ON) → ON → OFF 순으로 정한 상태.
 *   구성 /Intent 가 있으면 OCG /Intent 와 맞지 않을 때 숨김. /Usage /View /ViewState /OFF 면 숨김.
 * - OCMD: /VE 가 있으면 보임(MuPDF 미구현과 같게). /P(AnyOn 기본·AllOn·AnyOff·AllOff)로 /OCGs 결합.
 * - 그 밖의 객체·순환은 보임.
 */
import type * as mupdf from 'mupdf';

const key = (o: mupdf.PDFObject) => (o.isIndirect() ? `r${o.asIndirect()}` : null);
/** 널 객체에서도 안전한 get. */
const at = (o: mupdf.PDFObject, k: string) => (o.isNull() ? o : o.get(k));

export class OptionalContent {
  /** OCG 간접 번호 키 → 켜짐 여부. 비어 있으면 모든 콘텐츠가 보인다. */
  private readonly state = new Map<string, boolean>();
  private readonly intent: mupdf.PDFObject | null = null;

  constructor(doc: mupdf.PDFDocument) {
    const ocp = doc.getTrailer().get('Root').get('OCProperties');
    if (!ocp.isDictionary()) return;
    const ocgs = ocp.get('OCGs');
    if (!ocgs.isArray()) return;
    const cfg = ocp.get('D');
    const base = at(cfg, 'BaseState');
    const on = !(base.isName() && base.asName() === 'OFF');
    const unchanged = base.isName() && base.asName() === 'Unchanged';
    for (let i = 0; i < ocgs.length; i++) {
      const k = key(ocgs.get(i));
      if (k) this.state.set(k, unchanged ? true : on);
    }
    const apply = (name: string, value: boolean) => {
      const arr = at(cfg, name);
      if (!arr.isArray()) return;
      for (let i = 0; i < arr.length; i++) {
        const k = key(arr.get(i));
        if (k && this.state.has(k)) this.state.set(k, value);
      }
    };
    apply('ON', true);
    apply('OFF', false);
    const intent = at(cfg, 'Intent');
    this.intent = intent.isNull() ? null : intent;
  }

  /** 모든 콘텐츠가 보이는 문서인지(OCG 정의 없음). */
  get empty(): boolean {
    return this.state.size === 0;
  }

  /**
   * oc 가 숨김인지. oc 는 OCG·OCMD 사전 또는 이름(Properties 리소스에서 찾음).
   * properties 는 이름 해석용 /Properties 사전(없으면 null).
   */
  isHidden(oc: mupdf.PDFObject, properties: mupdf.PDFObject | null = null): boolean {
    if (this.state.size === 0) return false;
    let obj = oc;
    if (obj.isName()) {
      if (!properties || !properties.isDictionary()) return false;
      obj = at(properties, obj.asName());
    }
    if (obj.isNull()) return false;
    return this.hidden(obj, new Set());
  }

  private hidden(obj: mupdf.PDFObject, seen: Set<string>): boolean {
    const k = key(obj);
    if (k) {
      if (seen.has(k)) return false;
      seen.add(k);
    }
    const type = obj.get('Type');
    const typeName = type.isName() ? type.asName() : '';
    if (typeName === 'OCG') {
      const defaultHidden = k !== null && this.state.has(k) ? !this.state.get(k) : false;
      if (this.intent && !(this.intent.isArray() && this.intent.length === 0)) {
        const oi = obj.get('Intent');
        if (oi.isName()) {
          if (!this.intentIncludes(oi.asName())) return true;
        } else if (oi.isArray()) {
          let match = false;
          for (let i = 0; i < oi.length && !match; i++) {
            const n = oi.get(i);
            match = n.isName() && this.intentIncludes(n.asName());
          }
          if (!match) return true;
        } else if (!this.intentIncludes('View')) {
          return true;
        }
      }
      const usage = obj.get('Usage');
      if (!usage.isDictionary()) return defaultHidden;
      const es = at(at(usage, 'View'), 'ViewState');
      if (es.isName() && es.asName() === 'OFF') return true;
      return defaultHidden;
    }
    if (typeName === 'OCMD') {
      if (obj.get('VE').isArray()) return false;
      const p = obj.get('P');
      const pn = p.isName() ? p.asName() : 'AnyOn';
      const combine = pn === 'AllOn' ? 1 : pn === 'AnyOff' ? 2 : pn === 'AllOff' ? 3 : 0;
      const ocgs = obj.get('OCGs');
      let on: boolean;
      if (ocgs.isArray()) {
        on = (combine & 1) !== 0;
        for (let i = 0; i < ocgs.length; i++) {
          let h = this.hidden(ocgs.get(i), new Set(seen));
          if ((combine & 1) === 0) h = !h;
          if (combine & 2) on = on && h;
          else on = on || h;
        }
      } else {
        on = ocgs.isNull() ? false : this.hidden(ocgs, new Set(seen));
        if ((combine & 1) === 0) on = !on;
      }
      return !on;
    }
    return false;
  }

  private intentIncludes(name: string): boolean {
    if (name === 'All') return true;
    const intent = this.intent;
    if (!intent) return name === 'View';
    if (intent.isName()) return intent.asName() === 'All' || intent.asName() === name;
    if (!intent.isArray()) return false;
    for (let i = 0; i < intent.length; i++) {
      const n = intent.get(i);
      if (n.isName() && (n.asName() === 'All' || n.asName() === name)) return true;
    }
    return false;
  }
}
