import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { ContactSuggestion } from '@mail/shared';
import { api } from '../../api';
import { formatRecipients, parseRecipients, parseRecipientToken, type RecipientEntry } from './markdown-paste';

type Props = {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onChange: (nextValue: string) => void;
};

export function RecipientInput({ id, label, value, placeholder, autoFocus = false, disabled = false, onChange }: Props) {
  const entries = useMemo(() => parseRecipients(value), [value]);
  const [draftText, setDraftText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(draftText.trim()), 160);
    return () => clearTimeout(timer);
  }, [draftText]);

  const contacts = useQuery({
    queryKey: ['contacts', debounced],
    queryFn: () => api<ContactSuggestion[]>(`/contacts${debounced ? `?q=${encodeURIComponent(debounced)}` : ''}`),
    enabled: focused && !disabled,
    staleTime: 30_000,
  });

  const existingSet = useMemo(() => new Set(entries.map(item => item.address.toLowerCase())), [entries]);
  const suggestions = useMemo(
    () => (contacts.data ?? []).filter(item => !existingSet.has(item.address.toLowerCase())).slice(0, 8),
    [contacts.data, existingSet],
  );
  const showMenu = focused && !disabled && (debounced.length > 0 || entries.length === 0) && suggestions.length > 0;

  useEffect(() => { setActiveIndex(0); }, [suggestions.length, debounced]);

  function commitTokens(rawText: string) {
    const parsed = parseRecipients(rawText);
    if (!parsed.length) return;
    const next = [...entries];
    const seen = new Set(entries.map(item => item.address.toLowerCase()));
    for (const entry of parsed) {
      const key = entry.address.toLowerCase();
      if (entry.valid && seen.has(key)) continue;
      seen.add(key);
      next.push(entry);
    }
    onChange(formatRecipients(next));
  }

  function addSuggestion(contact: ContactSuggestion) {
    const token = parseRecipientToken(contact.name ? `${contact.name} <${contact.address}>` : contact.address);
    const next = [...entries, token];
    onChange(formatRecipients(next));
    setDraftText('');
    inputRef.current?.focus();
  }

  function removeAt(index: number) {
    const next = entries.filter((_, i) => i !== index);
    onChange(formatRecipients(next));
  }

  function editChip(index: number) {
    if (disabled) return;
    const target = entries[index];
    removeAt(index);
    setDraftText(target.raw);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (showMenu) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex(current => (current + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex(current => (current - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setFocused(false);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && suggestions[activeIndex] && draftText.trim()) {
        event.preventDefault();
        addSuggestion(suggestions[activeIndex]);
        return;
      }
    }

    if (event.key === 'Enter' || event.key === ',' || event.key === ';' || event.key === '，' || event.key === '；') {
      if (draftText.trim()) {
        event.preventDefault();
        commitTokens(draftText);
        setDraftText('');
      }
      return;
    }
    if (event.key === 'Tab' && draftText.trim()) {
      commitTokens(draftText);
      setDraftText('');
      return;
    }
    if (event.key === 'Backspace' && !draftText && entries.length > 0) {
      event.preventDefault();
      removeAt(entries.length - 1);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text/plain');
    if (text && /[,;，；\n\r]/.test(text)) {
      event.preventDefault();
      commitTokens(`${draftText} ${text}`);
      setDraftText('');
    }
  }

  function handleBlur() {
    if (draftText.trim()) {
      commitTokens(draftText);
      setDraftText('');
    }
    setFocused(false);
  }

  const chipTitle = (entry: RecipientEntry) => entry.valid
    ? (entry.name ? `${entry.name} <${entry.address}>（双击编辑）` : `${entry.address}（双击编辑）`)
    : `邮箱地址格式不正确：${entry.raw}（双击修改）`;

  return <div className="recipient-field">
    <div
      className={`recipient-box${focused ? ' focused' : ''}${disabled ? ' disabled' : ''}`}
      onMouseDown={event => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      {entries.map((entry, index) => (
        <span
          key={`${entry.address}-${index}`}
          className={`recipient-chip${entry.valid ? '' : ' invalid'}`}
          title={chipTitle(entry)}
          onDoubleClick={() => editChip(index)}
        >
          <span className="recipient-chip-text">{entry.name || entry.address}</span>
          {!disabled && (
            <button
              type="button"
              className="recipient-chip-remove"
              aria-label={`移除${label} ${entry.address}`}
              onMouseDown={event => event.preventDefault()}
              onClick={() => removeAt(index)}
            >
              <X size={12} aria-hidden />
            </button>
          )}
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={showMenu}
        aria-controls={showMenu ? listboxId : undefined}
        aria-activedescendant={showMenu ? `${listboxId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={draftText}
        placeholder={entries.length ? '' : placeholder}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        onChange={event => setDraftText(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
    </div>
    {showMenu && (
      <ul id={listboxId} role="listbox" className="recipient-suggestions" aria-label={`${label}建议`}>
        {suggestions.map((item, idx) => (
          <li
            key={item.address}
            id={`${listboxId}-${idx}`}
            role="option"
            aria-selected={idx === activeIndex}
            className={idx === activeIndex ? 'active' : undefined}
            onMouseEnter={() => setActiveIndex(idx)}
            onMouseDown={event => { event.preventDefault(); addSuggestion(item); }}
          >
            {item.name ? <><strong>{item.name}</strong><span>{item.address}</span></> : <strong>{item.address}</strong>}
          </li>
        ))}
      </ul>
    )}
  </div>;
}
