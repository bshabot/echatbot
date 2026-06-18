import { useRef, useState, useCallback } from 'react';
import html2pdf from 'html2pdf.js';
import ViewQuote from '../../Pages/ViewQuote';
import PDFPortal from './PdfPortal';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFilePdf } from '@fortawesome/free-solid-svg-icons';

export default function QuotePDFGenerator({ quoteNumber, quoteId }) {
  const quoteRef = useRef();
  const [renderQuote, setRenderQuote] = useState(false);
  const viewQuoteReadyRef = useRef(null);

  const waitForImagesToLoad = async (container) => {
    // Inline every image as a base64 data URL before html2canvas runs.
    // Cross-origin images (served from R2) taint the canvas, which makes
    // html2pdf silently drop them. Data URLs are same-origin, so they
    // always render into the PDF. R2 sends Access-Control-Allow-Origin: *,
    // so the cross-origin fetch below is allowed to read the bytes.
    const images = Array.from(container.querySelectorAll('img'));
    await Promise.all(
      images.map(async (img) => {
        const original = img.src;
        if (!original || original.startsWith('data:')) return;
        try {
          const res = await fetch(original, { mode: 'cors', cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          img.removeAttribute('crossorigin');
          img.src = dataUrl;
          if (!img.complete) {
            await new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
            });
          }
        } catch (err) {
          console.error(`Could not inline image for PDF: ${original}`, err);
        }
      })
    );
  };

  const handleViewQuoteReady = useCallback(() => {
    console.log('ViewQuote is ready!');
    if (viewQuoteReadyRef.current) {
      viewQuoteReadyRef.current();
    }
  }, []);

  const handleDownloadPDF = async () => {
    setRenderQuote(true);
    
    // Create a new promise for each PDF generation
    const viewQuoteReady = new Promise((resolve) => {
      viewQuoteReadyRef.current = resolve;
    });
    
    try {
      console.log('Waiting for ViewQuote to be ready...');
      // Wait for ViewQuote to signal it's ready
      await viewQuoteReady;
      console.log('ViewQuote is ready, proceeding with PDF generation...');
      
      if (quoteRef.current) {
        // Wait for all images to load
        await waitForImagesToLoad(quoteRef.current);
        
        console.log(quoteRef.current.innerHTML);
        
        const pdfOptions = {
          filename: `quote${quoteId}.pdf`,
          html2canvas: {
            scale: 2,
            useCORS: true,
            logging: true,
            allowTaint: false,
            backgroundColor: '#ffffff',
          },
          jsPDF: {
            unit: 'in',
            format: 'letter',
            orientation: 'portrait',
          },
        };
        
        const pdf = html2pdf()
          .set(pdfOptions)
          .from(quoteRef.current);
  
        const blob = await pdf.outputPdf('blob');
        const pdfUrl = URL.createObjectURL(blob);
        window.open(pdfUrl, '_blank');
        
        setTimeout(() => {
          URL.revokeObjectURL(pdfUrl);
        }, 1000);
      }
    } catch (error) {
      console.error('Error generating PDF:', error);
    } finally {
      setRenderQuote(false);
      viewQuoteReadyRef.current = null;
    }
  };
  
  return (
    <>
      <button onClick={handleDownloadPDF}>
        <FontAwesomeIcon icon={faFilePdf} size="lg" className="hover:text-blue-700" />
      </button>

      {renderQuote && (
        <PDFPortal>
          <div ref={quoteRef}>
            <ViewQuote 
              quoteId={quoteNumber} 
              forPdf={true} 
              resolve={handleViewQuoteReady}
            />
          </div>
        </PDFPortal>
      )}
    </>
  );
}