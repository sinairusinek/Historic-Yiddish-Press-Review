/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useMemo, ChangeEvent } from 'react';
import { 
  Upload, 
  FileJson, 
  FileText,
  Image as ImageIcon, 
  CheckCircle2, 
  Download, 
  ChevronRight, 
  ChevronLeft, 
  Edit3, 
  Save, 
  History,
  X,
  Search,
  Users,
  Calendar,
  MapPin,
  Building2,
  Tag,
  Layout,
  Check,
  AlertCircle,
  MessageSquare
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore - pdfjs-dist worker import
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { EditionBundle, Correction, Block, ContentUnit, Person, BlockStatus } from './types';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export default function App() {
  const [bundle, setBundle] = useState<EditionBundle | null>(null);
  const [initialBundle, setInitialBundle] = useState<EditionBundle | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [isProcessingPdf, setIsProcessingPdf] = useState(false);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [activeTab, setActiveTab] = useState<'ocr' | 'content' | 'people' | 'locations' | 'events'>('ocr');
  const [searchTerm, setSearchTerm] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const jsonInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleJsonUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        setBundle(data);
        setInitialBundle(JSON.parse(JSON.stringify(data)));
        if (data.corrections) {
          setCorrections(data.corrections);
        }
      } catch (err) {
        alert('Invalid JSON file');
      }
    };
    reader.readAsText(file);
  };

  const handlePdfUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !bundle) {
      if (!bundle) alert('Please upload JSON first to match pages');
      return;
    }

    setIsProcessingPdf(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const newImages: Record<string, string> = {};

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 }); // High resolution
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) continue;

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({ canvasContext: context, viewport }).promise;
        const dataUrl = canvas.toDataURL('image/webp');
        
        // Match with bundle pages
        const bundlePage = bundle.pages[i - 1];
        if (bundlePage) {
          const fileName = bundlePage.image.uri.split('/').pop() || '';
          newImages[fileName] = dataUrl;
        } else {
          newImages[`page_${i}.webp`] = dataUrl;
        }
      }

      setImages(newImages);
    } catch (err) {
      console.error('Error processing PDF:', err);
      alert('Failed to process PDF');
    } finally {
      setIsProcessingPdf(false);
    }
  };

  const addOrUpdateCorrection = (path: string, original: any, corrected: any, status: BlockStatus = 'pending', comment?: string) => {
    const newCorrection: Correction = {
      path,
      original,
      corrected,
      status,
      comment,
      timestamp: new Date().toISOString()
    };
    
    setCorrections(prev => {
      const existingIndex = prev.findIndex(c => c.path === path);
      if (existingIndex >= 0) {
        const updated = [...prev];
        updated[existingIndex] = newCorrection;
        return updated;
      }
      return [...prev, newCorrection];
    });

    // Update the bundle state immediately for UI feedback
    if (bundle) {
      const updatedBundle = JSON.parse(JSON.stringify(bundle));
      const parts = path.split('.');
      let current = updatedBundle;
      for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] === undefined) {
          console.warn(`Path ${path} not found in bundle at ${parts[i]}`);
          return;
        }
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = corrected;
      setBundle(updatedBundle);
    }
  };

  const handleDownload = () => {
    if (!initialBundle) return;
    const finalBundle = { ...initialBundle, corrections };
    const blob = new Blob([JSON.stringify(finalBundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pruzaner_review_${initialBundle.edition.date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getCorrectionForPath = (path: string) => {
    return corrections.find(c => c.path === path);
  };

  const filteredBlocks = useMemo(() => {
    if (!bundle) return [];
    const page = bundle.pages[currentPageIndex];
    if (!page) return [];
    return page.blocks.filter(b => 
      b.transcription.toLowerCase().includes(searchTerm.toLowerCase()) ||
      b.id.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [bundle, currentPageIndex, searchTerm]);

  const currentPage = bundle?.pages[currentPageIndex];
  
  const pageImageData = useMemo(() => {
    if (!currentPage) return null;
    const uri = currentPage.image.uri;
    const fileName = uri.split('/').pop() || '';
    const baseName = fileName.substring(0, fileName.lastIndexOf('.'));
    
    // Try exact match
    if (images[fileName]) return images[fileName];
    
    // Try matching by base name with common extensions
    const extensions = ['.avif', '.webp', '.png', '.jpg', '.jpeg'];
    for (const ext of extensions) {
      const candidate = baseName + ext;
      if (images[candidate]) return images[candidate];
    }
    
    return null;
  }, [currentPage, images]);

  // Auto-zoom to selected block
  useEffect(() => {
    if (!selectedBlockId || !currentPage || !containerRef.current) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }

    const updateZoom = () => {
      const block = currentPage.blocks.find(b => b.id === selectedBlockId);
      if (!block || !containerRef.current) {
        setZoom(1);
        setPan({ x: 0, y: 0 });
        return;
      }

      const [bx, by, bw, bh] = block.bbox;
      const { width: iw, height: ih } = currentPage.image;
      const { clientWidth: cw, clientHeight: ch } = containerRef.current;
      
      if (cw === 0 || ch === 0) return;

      // Calculate the rendered size of the image (object-contain)
      const containerRatio = cw / ch;
      const imageRatio = iw / ih;
      let renderedWidth, renderedHeight;
      if (imageRatio > containerRatio) {
        renderedWidth = cw;
        renderedHeight = cw / imageRatio;
      } else {
        renderedHeight = ch;
        renderedWidth = ch * imageRatio;
      }

      // Scale needed to make the block fill ~80% of the viewport
      const targetSize = Math.min(cw, ch) * 0.8;
      const blockMaxDim = Math.max(bw * (renderedWidth / iw), bh * (renderedHeight / ih));
      const calculatedZoom = targetSize / blockMaxDim;
      
      const newZoom = Math.min(Math.max(calculatedZoom, 1), 8);

      // Center the block
      const centerX = bx + bw / 2;
      const centerY = by + bh / 2;
      
      // The pan needs to account for the zoom factor because Framer Motion's 
      // percent-based translation is relative to the unscaled dimensions
      const tx = (0.5 - centerX / iw) * 100 * newZoom;
      const ty = (0.5 - centerY / ih) * 100 * newZoom;

      setZoom(newZoom);
      setPan({ x: tx, y: ty });
    };

    // Initial update with a small delay for sidebar transition
    const timer = setTimeout(updateZoom, 50);

    // Watch for container size changes (e.g. sidebar opening)
    const observer = new ResizeObserver(updateZoom);
    observer.observe(containerRef.current);

    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [selectedBlockId, currentPage, currentPageIndex]);

  if (!bundle) {
    return (
      <div className="min-h-screen bg-[#E4E3E0] flex items-center justify-center p-6 font-sans">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-2xl w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-black/5"
        >
          <div className="p-8 border-b border-black/5 bg-zinc-900 text-white">
            <h1 className="text-3xl font-serif italic mb-2">Pruzaner Sztyme Review</h1>
            <p className="text-zinc-400 text-sm">Historic Newspaper OCR Correction Tool</p>
          </div>
          
          <div className="p-8 space-y-8">
            <div className="grid grid-cols-1 gap-6">
              <div 
                onClick={() => jsonInputRef.current?.click()}
                className="group cursor-pointer p-6 border-2 border-dashed border-zinc-200 rounded-xl hover:border-zinc-900 transition-all bg-zinc-50"
              >
                <div className="w-12 h-12 bg-zinc-900 text-white rounded-lg flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <FileJson size={24} />
                </div>
                <h3 className="font-semibold mb-1">Step 1: Upload JSON</h3>
                <p className="text-xs text-zinc-500">OCR data and extracted entities</p>
                <input 
                  type="file" 
                  ref={jsonInputRef} 
                  onChange={handleJsonUpload} 
                  accept=".json" 
                  className="hidden" 
                />
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  if (Object.keys(images).length === 0) {
    return (
      <div className="min-h-screen bg-[#E4E3E0] flex items-center justify-center p-6 font-sans">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-2xl w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-black/5"
        >
          <div className="p-8 border-b border-black/5 bg-zinc-900 text-white">
            <h1 className="text-3xl font-serif italic mb-2">Pruzaner Sztyme Review</h1>
            <p className="text-zinc-400 text-sm">Historic Newspaper OCR Correction Tool</p>
          </div>
          
          <div className="p-8 space-y-8">
            <div 
              onClick={() => !isProcessingPdf && pdfInputRef.current?.click()}
              className={`group cursor-pointer p-6 border-2 border-dashed border-zinc-200 rounded-xl hover:border-zinc-900 transition-all bg-zinc-50 ${isProcessingPdf ? 'opacity-50 cursor-wait' : ''}`}
            >
              <div className="w-12 h-12 bg-zinc-900 text-white rounded-lg flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                {isProcessingPdf ? <div className="animate-spin rounded-full h-6 w-6 border-2 border-white border-t-transparent" /> : <FileText size={24} />}
              </div>
              <h3 className="font-semibold mb-1">Step 2: Upload PDF</h3>
              <p className="text-xs text-zinc-500">Single PDF containing all newspaper pages</p>
              <input 
                type="file" 
                ref={pdfInputRef} 
                onChange={handlePdfUpload} 
                accept=".pdf" 
                className="hidden" 
              />
            </div>
            {isProcessingPdf && (
              <p className="text-center text-sm text-zinc-500 animate-pulse">Converting PDF pages to images...</p>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  const pageImageName = currentPage?.image.uri.split('/').pop() || '';

  return (
    <div className="h-screen bg-[#E4E3E0] flex flex-col font-sans overflow-hidden">
      {/* Header */}
      <header className="h-16 bg-zinc-900 text-white flex items-center justify-between px-6 shrink-0 z-10">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-serif italic tracking-tight">Pruzaner Sztyme Review</h1>
          <div className="h-4 w-px bg-white/20" />
          <span className="text-xs font-mono text-zinc-400 uppercase tracking-widest">
            Edition: {bundle.edition.date} ({bundle.edition.hebrew_date})
          </span>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-white/10 rounded-full px-3 py-1 gap-2 border border-white/5">
            <History size={14} className="text-zinc-400" />
            <span className="text-xs font-medium">{corrections.length} Corrections</span>
          </div>
          <button 
            onClick={handleDownload}
            className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-emerald-900/20"
          >
            <Download size={16} />
            Download JSON
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Navigation & Lists */}
        <aside className="w-80 bg-white border-r border-black/5 flex flex-col shrink-0">
          <div className="flex border-b border-black/5">
            <button 
              onClick={() => setActiveTab('ocr')}
              className={`flex-1 py-3 text-xs font-bold uppercase tracking-tighter border-b-2 transition-colors ${activeTab === 'ocr' ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-400 hover:text-zinc-600'}`}
            >
              OCR Blocks
            </button>
            <button 
              onClick={() => setActiveTab('content')}
              className={`flex-1 py-3 text-xs font-bold uppercase tracking-tighter border-b-2 transition-colors ${activeTab === 'content' ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-400 hover:text-zinc-600'}`}
            >
              Units
            </button>
            <button 
              onClick={() => setActiveTab('people')}
              className={`flex-1 py-3 text-xs font-bold uppercase tracking-tighter border-b-2 transition-colors ${activeTab === 'people' ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-400 hover:text-zinc-600'}`}
            >
              People
            </button>
          </div>

          <div className="p-4 border-b border-black/5">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={14} />
              <input 
                type="text" 
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-zinc-100 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {activeTab === 'ocr' && (
              <div className="divide-y divide-black/5">
                {filteredBlocks.map((block) => {
                  const blockIdx = bundle.pages[currentPageIndex].blocks.indexOf(block);
                  const correction = getCorrectionForPath(`pages.${currentPageIndex}.blocks.${blockIdx}.transcription`);
                  const status = correction?.status || 'pending';
                  
                  return (
                    <div 
                      key={block.id}
                      onClick={() => setSelectedBlockId(block.id)}
                      className={`p-4 cursor-pointer transition-colors hover:bg-zinc-50 border-l-4 ${
                        selectedBlockId === block.id ? 'bg-zinc-100 border-zinc-900' : 
                        status === 'done_no_error' ? 'border-emerald-500 bg-emerald-50/30' :
                        status === 'done_errors_found' ? 'border-rose-500 bg-rose-50/30' :
                        'border-transparent'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-zinc-400 uppercase">{block.id}</span>
                          {correction?.comment && (
                            <MessageSquare size={10} className="text-zinc-400" />
                          )}
                        </div>
                        {status !== 'pending' && (
                          <span className={`w-2 h-2 rounded-full ${status === 'done_no_error' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                        )}
                      </div>
                      <p className="text-sm font-serif line-clamp-2 leading-relaxed" dir="rtl">
                        {block.transcription}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}

            {activeTab === 'content' && (
              <div className="divide-y divide-black/5">
                {bundle.content_units.filter(u => u.title.toLowerCase().includes(searchTerm.toLowerCase())).map((unit) => (
                  <div 
                    key={unit.id}
                    className="p-4 hover:bg-zinc-50 cursor-pointer"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Tag size={12} className="text-zinc-400" />
                      <span className="text-[10px] font-bold uppercase text-zinc-500">{unit.type}</span>
                    </div>
                    <h4 className="text-sm font-semibold mb-1">{unit.title}</h4>
                    <p className="text-xs text-zinc-400 line-clamp-1">{unit.category}</p>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'people' && (
              <div className="divide-y divide-black/5">
                {bundle.people.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase())).map((person) => (
                  <div 
                    key={person.id}
                    className="p-4 hover:bg-zinc-50 cursor-pointer flex items-center gap-3"
                  >
                    <div className="w-8 h-8 bg-zinc-100 rounded-full flex items-center justify-center shrink-0">
                      <Users size={14} className="text-zinc-500" />
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold">{person.name}</h4>
                      <p className="text-[10px] font-mono text-zinc-400 uppercase">{person.holocaust_fate}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="p-4 border-t border-black/5 bg-zinc-50 flex items-center justify-between">
            <button 
              disabled={currentPageIndex === 0}
              onClick={() => setCurrentPageIndex(p => p - 1)}
              className="p-2 hover:bg-white rounded-lg disabled:opacity-30 transition-colors"
            >
              <ChevronLeft size={20} />
            </button>
            <span className="text-xs font-bold font-mono">
              PAGE {currentPageIndex + 1} / {bundle.pages.length}
            </span>
            <button 
              disabled={currentPageIndex === bundle.pages.length - 1}
              onClick={() => setCurrentPageIndex(p => p + 1)}
              className="p-2 hover:bg-white rounded-lg disabled:opacity-30 transition-colors"
            >
              <ChevronRight size={20} />
            </button>
          </div>
        </aside>

        {/* Center: Image Viewer */}
        <section 
          ref={containerRef}
          onClick={() => setSelectedBlockId(null)}
          className="flex-1 bg-[#222] relative overflow-hidden flex items-center justify-center cursor-crosshair"
        >
          {/* Zoom Controls */}
          <div className="absolute bottom-6 right-6 z-20 flex flex-col gap-2">
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setZoom(z => Math.min(z + 0.5, 8));
              }}
              className="w-10 h-10 bg-white/10 hover:bg-white/20 text-white rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 transition-colors"
              title="Zoom In"
            >
              <Search size={18} className="scale-110" />
              <span className="absolute -top-1 -right-1 bg-emerald-500 text-[8px] font-bold px-1 rounded-full">+</span>
            </button>
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setZoom(z => Math.max(z - 0.5, 0.5));
              }}
              className="w-10 h-10 bg-white/10 hover:bg-white/20 text-white rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 transition-colors"
              title="Zoom Out"
            >
              <Search size={18} className="scale-110" />
              <span className="absolute -top-1 -right-1 bg-rose-500 text-[8px] font-bold px-1 rounded-full">-</span>
            </button>
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setZoom(1);
                setPan({ x: 0, y: 0 });
                setSelectedBlockId(null);
              }}
              className="w-10 h-10 bg-white/10 hover:bg-white/20 text-white rounded-full flex items-center justify-center backdrop-blur-md border border-white/10 transition-colors"
              title="Reset View"
            >
              <X size={18} />
            </button>
          </div>

          {pageImageData ? (
            <motion.div 
              animate={{ 
                scale: zoom,
                x: `${pan.x}%`,
                y: `${pan.y}%`
              }}
              transition={{ type: 'spring', damping: 25, stiffness: 120 }}
              className="relative max-h-full max-w-full shadow-2xl origin-center"
            >
              <img 
                src={pageImageData} 
                alt={`Page ${currentPageIndex + 1}`}
                className="max-h-[calc(100vh-4rem)] object-contain"
                referrerPolicy="no-referrer"
              />
              {/* Overlay Blocks */}
              <svg 
                className="absolute top-0 left-0 w-full h-full pointer-events-none"
                viewBox={`0 0 ${currentPage.image.width} ${currentPage.image.height}`}
              >
                {currentPage.blocks.map((block) => {
                  const [x, y, w, h] = block.bbox;
                  const isSelected = selectedBlockId === block.id;
                  const blockIdx = bundle.pages[currentPageIndex].blocks.indexOf(block);
                  const correction = getCorrectionForPath(`pages.${currentPageIndex}.blocks.${blockIdx}.transcription`);
                  const status = correction?.status || 'pending';
                  
                  return (
                    <rect 
                      key={block.id}
                      x={x} y={y} width={w} height={h}
                      className={`cursor-pointer pointer-events-auto transition-all ${
                        isSelected ? 'fill-emerald-500/20 stroke-emerald-500 stroke-[4]' : 
                        status === 'done_no_error' ? 'fill-emerald-500/10 stroke-emerald-500/50 stroke-[2]' :
                        status === 'done_errors_found' ? 'fill-rose-500/10 stroke-rose-500/50 stroke-[2]' :
                        'fill-transparent stroke-zinc-400/30 hover:stroke-white/50 stroke-[2]'
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedBlockId(block.id);
                      }}
                    />
                  );
                })}
              </svg>
            </motion.div>
          ) : (
            <div className="text-zinc-500 flex flex-col items-center gap-4">
              <ImageIcon size={48} className="opacity-20" />
              <p className="text-sm font-mono uppercase tracking-widest">Image not found: {pageImageName}</p>
              <button 
                onClick={() => pdfInputRef.current?.click()}
                className="text-xs bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-full transition-colors"
              >
                Upload PDF
              </button>
            </div>
          )}
        </section>

        {/* Right Sidebar: Editor */}
        <aside className="w-96 bg-white border-l border-black/5 flex flex-col shrink-0">
          <AnimatePresence mode="wait">
            {selectedBlockId ? (
              <motion.div 
                key={selectedBlockId}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="flex-1 flex flex-col overflow-hidden"
              >
                <div className="p-6 border-b border-black/5 flex items-center justify-between bg-zinc-50">
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-tight flex items-center gap-2">
                      <Edit3 size={14} />
                      Block Editor
                    </h3>
                    <p className="text-[10px] font-mono text-zinc-400 mt-1">{selectedBlockId}</p>
                  </div>
                  <button 
                    onClick={() => setSelectedBlockId(null)}
                    className="p-2 hover:bg-zinc-200 rounded-full transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-8">
                  {/* Transcription Editor */}
                  <div className="space-y-3">
                    <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest">Transcription (Yiddish)</label>
                    <textarea 
                      dir="rtl"
                      className="w-full h-48 p-4 bg-zinc-50 border border-black/5 rounded-xl font-serif text-lg leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-900/10 resize-none"
                      value={currentPage.blocks.find(b => b.id === selectedBlockId)?.transcription || ''}
                      onChange={(e) => {
                        const blockIndex = currentPage.blocks.findIndex(b => b.id === selectedBlockId);
                        const original = initialBundle?.pages?.[currentPageIndex]?.blocks?.[blockIndex]?.transcription || '';
                        const currentCorrection = getCorrectionForPath(`pages.${currentPageIndex}.blocks.${blockIndex}.transcription`);
                        addOrUpdateCorrection(
                          `pages.${currentPageIndex}.blocks.${blockIndex}.transcription`, 
                          original, 
                          e.target.value,
                          currentCorrection?.status || 'pending',
                          currentCorrection?.comment
                        );
                      }}
                    />
                  </div>

                  {/* Comment Editor */}
                  <div className="space-y-3">
                    <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest flex items-center gap-2">
                      <MessageSquare size={12} />
                      Reviewer Comment
                    </label>
                    <textarea 
                      className="w-full h-24 p-4 bg-zinc-50 border border-black/5 rounded-xl text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-900/10 resize-none"
                      placeholder="Add notes about this block..."
                      value={getCorrectionForPath(`pages.${currentPageIndex}.blocks.${currentPage.blocks.findIndex(b => b.id === selectedBlockId)}.transcription`)?.comment || ''}
                      onChange={(e) => {
                        const blockIndex = currentPage.blocks.findIndex(b => b.id === selectedBlockId);
                        const block = currentPage.blocks[blockIndex];
                        const original = initialBundle?.pages?.[currentPageIndex]?.blocks?.[blockIndex]?.transcription || '';
                        const currentCorrection = getCorrectionForPath(`pages.${currentPageIndex}.blocks.${blockIndex}.transcription`);
                        addOrUpdateCorrection(
                          `pages.${currentPageIndex}.blocks.${blockIndex}.transcription`,
                          original,
                          block.transcription,
                          currentCorrection?.status || 'pending',
                          e.target.value
                        );
                      }}
                    />
                  </div>

                  {/* Status Marking */}
                  <div className="space-y-3">
                    <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest">Review Status</label>
                    <div className="grid grid-cols-2 gap-3">
                      <button 
                        onClick={() => {
                          const blockIndex = currentPage.blocks.findIndex(b => b.id === selectedBlockId);
                          const block = currentPage.blocks[blockIndex];
                          const original = initialBundle?.pages?.[currentPageIndex]?.blocks?.[blockIndex]?.transcription || '';
                          const currentCorrection = getCorrectionForPath(`pages.${currentPageIndex}.blocks.${blockIndex}.transcription`);
                          addOrUpdateCorrection(
                            `pages.${currentPageIndex}.blocks.${blockIndex}.transcription`,
                            original,
                            block.transcription,
                            'done_no_error',
                            currentCorrection?.comment
                          );
                        }}
                        className={`flex items-center justify-center gap-2 p-3 rounded-xl border text-xs font-bold transition-all ${
                          getCorrectionForPath(`pages.${currentPageIndex}.blocks.${currentPage.blocks.findIndex(b => b.id === selectedBlockId)}.transcription`)?.status === 'done_no_error'
                          ? 'bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-600/20'
                          : 'bg-white border-zinc-200 text-zinc-600 hover:border-emerald-500 hover:text-emerald-600'
                        }`}
                      >
                        <Check size={14} />
                        No Error
                      </button>
                      <button 
                        onClick={() => {
                          const blockIndex = currentPage.blocks.findIndex(b => b.id === selectedBlockId);
                          const block = currentPage.blocks[blockIndex];
                          const original = initialBundle?.pages?.[currentPageIndex]?.blocks?.[blockIndex]?.transcription || '';
                          const currentCorrection = getCorrectionForPath(`pages.${currentPageIndex}.blocks.${blockIndex}.transcription`);
                          addOrUpdateCorrection(
                            `pages.${currentPageIndex}.blocks.${blockIndex}.transcription`,
                            original,
                            block.transcription,
                            'done_errors_found',
                            currentCorrection?.comment
                          );
                        }}
                        className={`flex items-center justify-center gap-2 p-3 rounded-xl border text-xs font-bold transition-all ${
                          getCorrectionForPath(`pages.${currentPageIndex}.blocks.${currentPage.blocks.findIndex(b => b.id === selectedBlockId)}.transcription`)?.status === 'done_errors_found'
                          ? 'bg-rose-600 border-rose-600 text-white shadow-lg shadow-rose-600/20'
                          : 'bg-white border-zinc-200 text-zinc-600 hover:border-rose-500 hover:text-rose-600'
                        }`}
                      >
                        <AlertCircle size={14} />
                        Errors Found
                      </button>
                    </div>
                  </div>

                  {/* Metadata Info */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-3 bg-zinc-50 rounded-lg border border-black/5">
                      <span className="text-[10px] font-bold uppercase text-zinc-400 block mb-1">Confidence</span>
                      <span className="text-sm font-mono">{(currentPage.blocks.find(b => b.id === selectedBlockId)?.confidence || 0) * 100}%</span>
                    </div>
                    <div className="p-3 bg-zinc-50 rounded-lg border border-black/5">
                      <span className="text-[10px] font-bold uppercase text-zinc-400 block mb-1">Content Unit</span>
                      <span className="text-sm font-mono truncate block">{currentPage.blocks.find(b => b.id === selectedBlockId)?.content_unit_id}</span>
                    </div>
                  </div>

                  {/* Content Unit Link */}
                  {(() => {
                    const block = currentPage.blocks.find(b => b.id === selectedBlockId);
                    const unit = bundle.content_units.find(u => u.id === block?.content_unit_id);
                    if (!unit) return null;
                    return (
                      <div className="space-y-3">
                        <label className="text-[10px] font-bold uppercase text-zinc-500 tracking-widest">Linked Content Unit</label>
                        <div className="p-4 bg-zinc-900 text-white rounded-xl shadow-lg">
                          <h4 className="font-semibold text-sm mb-1">{unit.title}</h4>
                          <p className="text-xs text-zinc-400 mb-3">{unit.category}</p>
                          <div className="space-y-2">
                            <span className="text-[10px] font-bold uppercase text-zinc-500 block">Translation Preview</span>
                            <p className="text-xs italic text-zinc-300 line-clamp-3 leading-relaxed">
                              {unit.english_translation}
                            </p>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </motion.div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-zinc-400">
                <div className="w-16 h-16 bg-zinc-50 rounded-full flex items-center justify-center mb-6">
                  <Layout size={32} className="opacity-20" />
                </div>
                <h3 className="font-serif italic text-lg text-zinc-900 mb-2">No Block Selected</h3>
                <p className="text-sm leading-relaxed">Select a block from the list or click on the image to begin reviewing and correcting the OCR transcription.</p>
              </div>
            )}
          </AnimatePresence>
        </aside>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(0,0,0,0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(0,0,0,0.2);
        }
      `}</style>
    </div>
  );
}
