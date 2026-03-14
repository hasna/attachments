import { useState, useEffect, useCallback, useRef } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import {
  Upload,
  Trash2,
  Download,
  Copy,
  Check,
  RefreshCw,
  FileText,
  Server,
  AlertCircle,
  X,
  Tag,
  Clock,
} from "lucide-react";
import {
  listAttachments,
  uploadAttachment,
  deleteAttachment,
  getLink,
  setBaseUrl,
  getBaseUrl,
  type Attachment,
} from "./api";
import "./App.css";

// helpers
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function isExpired(ts: number | null): boolean {
  if (!ts) return false;
  return ts < Date.now();
}

const EXPIRY_OPTIONS = [
  { label: "1 hour", value: "1h" },
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "Never", value: "never" },
];

// CopyButton
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };
  return (
    <button className="icon-btn" onClick={handleCopy} title="Copy link">
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

// UploadZone
interface UploadZoneProps {
  onUploaded: () => void;
}

function UploadZone({ onUploaded }: UploadZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [expiry, setExpiry] = useState("24h");
  const [tag, setTag] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setFiles((prev) => [...prev, ...Array.from(incoming)]);
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const handleUpload = async () => {
    if (!files.length) return;
    setUploading(true);
    setErrors([]);
    const errs: string[] = [];
    for (const file of files) {
      try {
        await uploadAttachment(
          file,
          { expiry: expiry !== "never" ? expiry : undefined, tag: tag || undefined },
          (pct) => setProgress((p) => ({ ...p, [file.name]: pct }))
        );
      } catch (e) {
        errs.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setUploading(false);
    setProgress({});
    setFiles([]);
    setTag("");
    setErrors(errs);
    onUploaded();
  };

  return (
    <div className="upload-zone-wrapper">
      <div
        className={`upload-zone ${dragging ? "drag-over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" multiple style={{ display: "none" }}
          onChange={(e) => addFiles(e.target.files)} />
        <Upload size={32} className="upload-icon" />
        <p className="upload-hint">Drag & drop files here or <strong>click to browse</strong></p>
      </div>

      {files.length > 0 && (
        <div className="upload-queue">
          {files.map((f, i) => (
            <div key={i} className="upload-item">
              <FileText size={14} />
              <span className="upload-name">{f.name}</span>
              <span className="upload-size">{fmtSize(f.size)}</span>
              {uploading && progress[f.name] !== undefined ? (
                <div className="progress-bar-wrap">
                  <div className="progress-bar" style={{ width: `${progress[f.name]}%` }} />
                </div>
              ) : (
                <button className="icon-btn" onClick={(e) => { e.stopPropagation(); removeFile(i); }}>
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="upload-options">
        <div className="upload-option">
          <Clock size={14} />
          <label>Expiry</label>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="upload-option">
          <Tag size={14} />
          <label>Tag</label>
          <input type="text" placeholder="optional tag" value={tag} onChange={(e) => setTag(e.target.value)} />
        </div>
        <button className="btn btn-primary" onClick={handleUpload} disabled={uploading || files.length === 0}>
          {uploading ? <RefreshCw size={14} className="spin" /> : <Upload size={14} />}
          {uploading ? "Uploading…" : `Upload${files.length > 0 ? ` (${files.length})` : ""}`}
        </button>
      </div>

      {errors.map((e, i) => (
        <div key={i} className="error-msg"><AlertCircle size={14} /> {e}</div>
      ))}
    </div>
  );
}

// CopyLinkButton
function CopyLinkButton({ id, getLinkFn }: { id: string; getLinkFn: (id: string) => Promise<string> }) {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const handleCopy = async () => {
    setLoading(true);
    try {
      const link = await getLinkFn(id);
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };
  return (
    <button className="icon-btn" onClick={handleCopy} title="Copy link" disabled={loading}>
      {loading ? <RefreshCw size={12} className="spin" /> : copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
    </button>
  );
}

// Main App
const columnHelper = createColumnHelper<Attachment>();

export default function App() {
  const [serverUrl, setServerUrl] = useState(getBaseUrl());
  const [serverUrlDraft, setServerUrlDraft] = useState(getBaseUrl());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExpired, setShowExpired] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  const [search, setSearch] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listAttachments({ limit: 200, includeExpired: showExpired, tag: tagFilter || undefined });
      setAttachments(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [showExpired, tagFilter]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteAttachment(id);
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  };

  const handleGetLink = async (id: string): Promise<string> => {
    const { link } = await getLink(id);
    return link ?? "";
  };

  const totalSize = attachments.reduce((s, a) => s + (a.size ?? 0), 0);
  const expiredCount = attachments.filter((a) => isExpired(a.expires_at)).length;
  const allTags = [...new Set(attachments.map((a) => a.tag).filter(Boolean))] as string[];

  const filteredData = attachments.filter((a) => {
    if (!search) return true;
    return a.filename.toLowerCase().includes(search.toLowerCase());
  });

  const columns = [
    columnHelper.accessor("filename", {
      header: "Filename",
      cell: (info) => (
        <span className={`filename ${isExpired(info.row.original.expires_at) ? "expired" : ""}`}>
          <FileText size={13} />
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.accessor("size", {
      header: "Size",
      cell: (info) => <span className="mono">{fmtSize(info.getValue())}</span>,
    }),
    columnHelper.accessor("tag", {
      header: "Tag",
      cell: (info) => info.getValue()
        ? <span className="tag-badge">{info.getValue()}</span>
        : <span className="muted">—</span>,
    }),
    columnHelper.accessor("link", {
      header: "Link",
      cell: (info) => {
        const link = info.getValue();
        return link ? (
          <span className="link-cell">
            <a href={link} target="_blank" rel="noopener noreferrer" className="link-text">
              {link.length > 38 ? link.slice(0, 38) + "…" : link}
            </a>
            <CopyLinkButton id={info.row.original.id} getLinkFn={handleGetLink} />
          </span>
        ) : <span className="muted">—</span>;
      },
    }),
    columnHelper.accessor("expires_at", {
      header: "Expires",
      cell: (info) => {
        const ts = info.getValue();
        const exp = isExpired(ts);
        return (
          <span className={exp ? "text-danger" : ""}>
            {ts ? fmtDate(ts) : "Never"}
            {exp && " (expired)"}
          </span>
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      header: "Actions",
      cell: (info) => (
        <span className="actions-cell">
          <a href={`${serverUrl}/api/attachments/${info.row.original.id}/download`}
            className="icon-btn" title="Download" target="_blank" rel="noopener noreferrer">
            <Download size={14} />
          </a>
          <button className="icon-btn icon-btn-danger" title="Delete"
            disabled={deletingId === info.row.original.id}
            onClick={() => handleDelete(info.row.original.id)}>
            {deletingId === info.row.original.id
              ? <RefreshCw size={14} className="spin" />
              : <Trash2 size={14} />}
          </button>
        </span>
      ),
    }),
  ];

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const handleServerApply = () => {
    setBaseUrl(serverUrlDraft);
    setServerUrl(serverUrlDraft);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <Server size={20} />
          <span>@hasna/attachments</span>
        </div>
        <div className="server-config">
          <input className="server-input" value={serverUrlDraft}
            onChange={(e) => setServerUrlDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleServerApply()}
            placeholder="http://localhost:3457" />
          <button className="btn btn-sm" onClick={handleServerApply}>Apply</button>
        </div>
        <div className="stats-bar">
          <span className="stat"><FileText size={13} /> {attachments.length} files</span>
          <span className="stat">&#128190; {fmtSize(totalSize)}</span>
          {expiredCount > 0 && (
            <span className="stat text-danger"><AlertCircle size={13} /> {expiredCount} expired</span>
          )}
        </div>
      </header>

      <main className="main">
        <section className="section">
          <h2 className="section-title"><Upload size={16} /> Upload</h2>
          <UploadZone onUploaded={load} />
        </section>

        <section className="section">
          <div className="table-header">
            <h2 className="section-title"><FileText size={16} /> Attachments</h2>
            <div className="filter-bar">
              <input className="search-input" placeholder="Search filename…"
                value={search} onChange={(e) => setSearch(e.target.value)} />
              <select className="tag-select" value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}>
                <option value="">All tags</option>
                {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <label className="toggle-label">
                <input type="checkbox" checked={showExpired}
                  onChange={(e) => setShowExpired(e.target.checked)} />
                Show expired
              </label>
              <button className="btn btn-sm" onClick={load} disabled={loading}>
                {loading ? <RefreshCw size={14} className="spin" /> : <RefreshCw size={14} />}
                Refresh
              </button>
            </div>
          </div>

          {error && (
            <div className="error-msg"><AlertCircle size={14} /> {error}</div>
          )}

          <div className="table-wrap">
            <table className="table">
              <thead>
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <th key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.length === 0 ? (
                  <tr>
                    <td colSpan={columns.length} className="empty-row">
                      {loading ? "Loading…" : "No attachments found"}
                    </td>
                  </tr>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <tr key={row.id} className={isExpired(row.original.expires_at) ? "row-expired" : ""}>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

// suppress unused import warning for CopyButton (used inline)
export { CopyButton };
