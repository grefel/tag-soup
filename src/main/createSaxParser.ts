import {createObjectPool, ObjectPool} from './createObjectPool';
import {allCharBy, char, charBy, CharCodeChecker, seq, substr, untilCharBy, untilSubstr} from './dsl-utils';
import {CharCode} from './CharCode';
import {createEntitiesDecoder} from './createEntitiesDecoder';
import {Rewriter} from './shared-types';

const xmlDecoder = createEntitiesDecoder();

export function identity<T>(value: T): T {
  return value;
}

// https://www.w3.org/TR/xml/#NT-S
const isSpaceChar: CharCodeChecker = (c) => c === 0x20 || c === 0x09 || c === 0xD || c === 0xA;

// https://www.w3.org/TR/xml/#NT-NameStartChar
const isTagNameStartChar: CharCodeChecker = (c) => (
    c >= 97 && c <= 122 // a-z
    || c >= 65 && c <= 90 // A-Z
    || c === 95 // "_"
    || c === 58 // ":"
    || c >= 0xc0 && c <= 0xd6
    || c >= 0xd8 && c <= 0xf6
    || c >= 0xf8 && c <= 0x2ff
    || c >= 0x370 && c <= 0x37d
    || c >= 0x37f && c <= 0x1fff
    || c >= 0x200c && c <= 0x200d
    || c >= 0x2070 && c <= 0x218f
    || c >= 0x2c00 && c <= 0x2fef
    || c >= 0x3001 && c <= 0xd7ff
    || c >= 0xf900 && c <= 0xfdcf
    || c >= 0xfdf0 && c <= 0xfffd
    || c >= 0x10000 && c <= 0xeffff
);

/**
 * Check if char should be treated as a whitespace inside tag.
 */
const isTagSpaceChar: CharCodeChecker = (c) => isSpaceChar(c) || c === CharCode.SLASH;

const isNotTagNameChar: CharCodeChecker = (c) => isSpaceChar(c) || c === CharCode.SLASH || c === CharCode.GT;

const isNotAttrNameChar: CharCodeChecker = (c) => isSpaceChar(c) || c === CharCode.SLASH || c === CharCode.GT || c === CharCode.EQ;

const isNotUnquotedValueChar: CharCodeChecker = (c) => isSpaceChar(c) || c === CharCode.GT;

const takeText = untilSubstr('<', false, false);

const takeUntilGt = untilSubstr('>', true, false);

const takeTagNameStartChar = charBy(isTagNameStartChar);
const takeTagNameChars = untilCharBy(isNotTagNameChar, false, true);

// <okay
const takeStartTagOpening = seq(char(CharCode.LT), takeTagNameStartChar, takeTagNameChars);

// </okay
const takeEndTagOpening = seq(substr('</'), takeTagNameStartChar, takeTagNameChars);

const takeTagSpace = allCharBy(isTagSpaceChar);

const takeAttrName = untilCharBy(isNotAttrNameChar, false, true);

const takeSpace = allCharBy(isSpaceChar);

// =
const takeEq = seq(takeSpace, char(CharCode.EQ), takeSpace);

// "okay"
const takeQuotValue = seq(char(CharCode.QUOT), untilSubstr('"', true, true));

// 'okay'
const takeAposValue = seq(char(CharCode.APOS), untilSubstr("'", true, true));

// okay
const takeUnquotedValue = untilCharBy(isNotUnquotedValueChar, false, true);

// <!--okay-->
const takeComment = seq(substr('<!--'), untilSubstr('-->', true, true));

// <!okay>
const takeWeirdComment = seq(substr('<!'), untilSubstr('>', true, true));

// <?okay?>
const takeProcessingInstruction = seq(substr('<?'), untilSubstr('?>', true, true));

// <![CDATA[okay]]>
const takeCdataSection = seq(substr('<![CDATA['), untilSubstr(']]>', true, true));

// <!DOCTYPE html>
const takeDocumentType = seq(substr('<!DOCTYPE', true), untilSubstr('>', true, true));

export function createAttr(): Attribute {
  return {
    name: '',
    value: '',
    start: 0,
    end: 0,
  };
}

export function traverseAttrs(str: string, i: number, attrPool: ObjectPool<Attribute>, decode: Rewriter, rename: Rewriter): number {
  const charCount = str.length;

  while (i < charCount) {

    let value = '';
    let start = takeTagSpace(str, i);
    let k = start;
    let j = takeAttrName(str, k);

    // No attribute available
    if (j === k) {
      break;
    }

    const attr = attrPool.allocate();

    attr.name = rename(str.substring(k, j));

    k = j;
    j = takeEq(str, k);

    // Equals sign presents, so there may be a value
    if (j !== -1) {
      k = j;

      // Quoted value
      j = takeQuotValue(str, k);
      if (j === -1) {
        j = takeAposValue(str, k);
      }
      if (j !== -1) {
        value = decode(str.substring(k + 1, j - 1));
        k = Math.min(j, charCount);
      } else {

        // Unquoted value
        j = takeUnquotedValue(str, k);
        if (j !== k) {
          value = decode(str.substring(k, j));
          k = j;
        }
      }
    }

    attr.value = value;
    attr.start = start;
    attr.end = k;

    i = k;
  }
  return i;
}

export interface Attribute {
  name: string;
  value: string;
  start: number;
  end: number;
}

export type StartTagCallback = (tagName: string, selfClosing: boolean, start: number, end: number) => void;

export type AttributeCallback = (name: string, value: string, start: number, end: number) => void;

export type EndTagCallback = (tagName: string, selfClosing: boolean, start: number, end: number) => void;

export type DataCallback = (data: string, start: number, end: number) => void;

export interface SaxParserDialectOptions {

  /**
   * If set to `true` then CDATA sections and processing instructions are recognized, self-closing tags are enabled and
   * tag names are case-sensitive. Otherwise, CDATA sections and processing instructions are emitted as comments,
   * self-closing tags are treated as start tags and tag names are case-insensitive.
   *
   * @default false
   */
  xmlEnabled?: boolean;

  /**
   * Receives attribute value and returns string with decoded entities. By default, only XML entities are decoded.
   */
  decodeAttr?: Rewriter;

  /**
   * Receives text node value and returns string with decoded entities. By default, only XML entities are decoded.
   */
  decodeText?: Rewriter;
  renameTag?: Rewriter;
  renameAttr?: Rewriter;
  selfClosingEnabled?: boolean;

  /**
   * If returns `true` then contents of the tag are treated as plain text.
   */
  isRawTag?: (tagName: string) => boolean;
}

export interface SaxParserCallbacks {
  onStartTag?: StartTagCallback;
  onAttribute?: AttributeCallback;
  onEndTag?: EndTagCallback;
  onText?: DataCallback;
  onComment?: DataCallback;
  onProcessingInstruction?: DataCallback;
  onCdataSection?: DataCallback;
  onDocumentType?: DataCallback;
}

export interface SaxParserOptions extends SaxParserDialectOptions, SaxParserCallbacks {
}

export interface SaxParser {

  readonly tail: string;
  readonly offset: number;

  resetStream(): void;

  writeStream(str: string): void;

  commit(str?: string): void;
}

export function createSaxParser(options: SaxParserOptions): SaxParser {
  const attrPool = createObjectPool(createAttr);

  let tail = '';
  let offset = 0;

  return {
    get tail() {
      return tail;
    },
    get offset() {
      return offset;
    },

    resetStream() {
      tail = '';
      offset = 0;
    },
    writeStream(str) {
      const i = parseSax(tail + str, attrPool, true, offset, options);
      tail = str.substr(i);
      offset += i;
    },
    commit(str = '') {
      parseSax(tail + str, attrPool, false, offset, options);
      tail = '';
      offset = 0;
    },
  };
}

export function parseSax(str: string, attrPool: ObjectPool<Attribute>, streaming: boolean, offset: number, options: SaxParserOptions): number {
  const {
    xmlEnabled = false,
    decodeAttr = xmlDecoder,
    decodeText = xmlDecoder,
    renameTag = identity,
    renameAttr = identity,
    selfClosingEnabled = false,
    isRawTag,

    onStartTag,
    onAttribute,
    onEndTag,
    onText,
    onComment,
    onProcessingInstruction,
    onCdataSection,
    onDocumentType,
  } = options;

  let textStart = -1;
  let textEnd = -1;
  let rawTagName: string | null = null;

  // Emits text chunk if any
  const emitText = () => {
    if (textStart !== -1) {
      onText?.(decodeText(str.substring(textStart, textEnd)), offset + textStart, offset + textEnd);
      textStart = textEnd = -1;
    }
  };

  const emitData = (cb: DataCallback | undefined, i: number, j: number, di: number, dj: number): number => {
    emitText();

    const k = j > charCount ? charCount : j;
    cb?.(str.substring(i + di, j - dj), offset + i, offset + k);
    return k;
  };

  const charCount = str.length;

  let i = 0;
  let j;

  while (i < charCount) {

    // Text
    if (textStart === -1) {
      let k = takeText(str, i);

      if (k === -1 && (k = charCount) && streaming) {
        break;
      }
      if (k !== i) {
        textStart = i;
        textEnd = i = k;
        continue;
      }
    }

    // Outside of the raw context
    if (!rawTagName) {

      // Start tag
      j = takeStartTagOpening(str, i);
      if (j !== -1) {
        const tagName = renameTag(str.substring(i + 1, j));

        attrPool.reset();
        j = traverseAttrs(str, j, attrPool, decodeAttr, renameAttr);

        // Skip malformed content and excessive whitespaces
        const k = takeUntilGt(str, j);

        if (k === -1) {
          // Unterminated start tag
          return i;
        }

        const selfClosing = (xmlEnabled || selfClosingEnabled) && k - j >= 2 && str.charCodeAt(k - 2) === CharCode.SLASH;

        emitText();
        onStartTag?.(tagName, selfClosing, offset + i, offset + k);

        if (onAttribute) {
          for (let i = 0, n = attrPool.countAllocations(); i < n; i++) {
            const attr = attrPool.cache[i];
            onAttribute(attr.name, attr.value, offset + attr.start, offset + attr.end);
          }
        }

        if (selfClosing) {

          // Emit self-closing start tag
          onEndTag?.(tagName, true, offset + k - 2, offset + k);
        } else {

          // Enforce CDATA context only for non self-closing tags
          if (isRawTag?.(tagName)) {
            rawTagName = xmlEnabled ? tagName : tagName.toLowerCase();
          }
        }

        i = k;
        continue;
      }
    }

    // End tag (can be inside the raw context)
    j = takeEndTagOpening(str, i);
    if (j !== -1) {
      const tagName = renameTag(str.substring(i + 2, j));

      if (!rawTagName || (xmlEnabled ? tagName : tagName.toLowerCase()) === rawTagName) {
        rawTagName = null;

        // Skip malformed content and excessive whitespaces
        const k = takeUntilGt(str, j);

        if (k === -1) {
          // Unterminated end tag
          return i;
        }

        emitText();
        onEndTag?.(tagName, false, offset + i, offset + k);

        i = k;
        continue;
      }
    }

    // Outside of the raw context
    if (!rawTagName) {
      let k;

      // Comment
      k = j = takeComment(str, i);
      if (j !== -1) {
        if (j > charCount && streaming) {
          return i;
        }
        i = emitData(onComment, i, j, 4, 3);
        continue;
      }

      // Doctype
      k = j = takeDocumentType(str, i);
      if (j !== -1) {
        if (j > charCount && streaming) {
          return i;
        }
        i = emitData(onDocumentType, i, j, 9, 1);
        continue;
      }

      // CDATA section
      j = takeCdataSection(str, i);
      if (j !== -1) {
        if (j > charCount && streaming) {
          return i;
        }
        i = xmlEnabled ? emitData(onCdataSection, i, j, 9, 3) : emitData(onComment, i, j, 2, 1);
        continue;
      }

      // Processing instruction
      j = takeProcessingInstruction(str, i);
      if (j !== -1) {
        if (j > charCount && streaming) {
          return i;
        }
        i = xmlEnabled ? emitData(onProcessingInstruction, i, j, 2, 2) : emitData(onComment, i, j, 1, 1);
        continue;
      }

      // Weird comments
      if (!xmlEnabled) {
        j = takeWeirdComment(str, i);
        if (j !== -1) {
          if (j > charCount && streaming) {
            return i;
          }
          i = emitData(onComment, i, j, 2, 1);
          continue;
        }
      }
    }

    // Concat with existing text
    if (textStart === -1) {
      textStart = i;
    }
    textEnd = takeText(str, i + 1);

    if (textEnd === -1) {
      textEnd = charCount;
      break;
    }
    i = textEnd;
  }

  if (streaming) {
    if (textStart !== -1) {
      return textStart;
    }
    return i;
  }

  emitText();
  return i;
}