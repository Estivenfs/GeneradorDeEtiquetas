import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  Alert,
  Box,
  Button,
  Chip,
  List,
  ListItem,
  ListItemText,
  Snackbar,
  Stack,
  Typography,
  useMediaQuery,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import ShareIcon from '@mui/icons-material/Share';
import StopIcon from '@mui/icons-material/Stop';
import HomeIcon from '@mui/icons-material/Home';
import { useNavigate } from 'react-router-dom';
import { httpClient } from '../../../shared/api/httpClient';
import { useScanHistory } from '../hooks/useScanHistory';
import type { ScanResult } from '../hooks/useScanHistory';

interface ScanResponse {
  data: ScanResult;
}

interface ScannedEntry {
  time: number;
  status: 'pending' | 'ok' | 'error';
  reference: string | null;
  dispatched: boolean;
}

const SCAN_INTERVAL_MS = 150;
const RESCAN_NOTICE_MS = 5000;
const MAX_SCAN_WIDTH = 640;
const FEEDBACK_INTERVAL_MS = 1500;

export function PickerScanPage() {
  const navigate = useNavigate();
  const { addScanResult } = useScanHistory();
  const [scannedLabels, setScannedLabels] = useState<ScanResult[]>([]);
  const [showReport, setShowReport] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanSuccess, setScanSuccess] = useState(false);
  const [alreadyDispatchedNotice, setAlreadyDispatchedNotice] = useState<string | null>(null);
  const [alreadyScannedNotice, setAlreadyScannedNotice] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);

  const detectorRef = useRef<BarcodeDetector | null>(null);
  const scanInFlightRef = useRef(false);
  const scannedCodesRef = useRef<Map<string, ScannedEntry>>(new Map());
  const successTimerRef = useRef<number | null>(null);
  const lastFeedbackRef = useRef<{ code: string; time: number } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const isSmallHeight = useMediaQuery('(max-height:680px)');

  const playBeep = useCallback(() => {
    audioCtxRef.current ??= typeof AudioContext !== 'undefined' ? new AudioContext() : null;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.15);
  }, []);

  const handleDetectedCode = useCallback(
    (qrData: string) => {
      const now = Date.now();

      const lastFeedback = lastFeedbackRef.current;
      if (
        !lastFeedback ||
        lastFeedback.code !== qrData ||
        now - lastFeedback.time >= FEEDBACK_INTERVAL_MS
      ) {
        lastFeedbackRef.current = { code: qrData, time: now };
        setScanSuccess(true);
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = window.setTimeout(() => setScanSuccess(false), 300);
        playBeep();
      }

      const existing = scannedCodesRef.current.get(qrData);

      if (existing) {
        if (now - existing.time < RESCAN_NOTICE_MS) return;

        existing.time = now;

        if (existing.status === 'ok') {
          if (existing.dispatched) {
            setAlreadyDispatchedNotice(existing.reference ?? 'Etiqueta');
          } else {
            setAlreadyScannedNotice(existing.reference ?? 'Etiqueta');
          }
          return;
        }

        existing.status = 'pending';
      } else {
        scannedCodesRef.current.set(qrData, {
          time: now,
          status: 'pending',
          reference: null,
          dispatched: false,
        });
      }

      httpClient
        .post('/labels/scan', { qrData })
        .then(({ data }) => {
          const response = data as ScanResponse;
          const entry = scannedCodesRef.current.get(qrData);
          if (entry) {
            entry.status = 'ok';
            entry.reference = response.data.externalReference;
            entry.dispatched = response.data.alreadyDispatched;
          }

          const result: ScanResult = {
            ...response.data,
            scannedAt: new Date().toLocaleTimeString('es-AR'),
          };

          if (result.alreadyDispatched) {
            setAlreadyDispatchedNotice(result.externalReference);
            return;
          }

          setScannedLabels((prev) => [result, ...prev]);
          addScanResult(result);
        })
        .catch((err) => {
          const entry = scannedCodesRef.current.get(qrData);
          if (entry) entry.status = 'error';

          const msg =
            err?.response?.data?.error?.message ??
            err?.message ??
            'Error al procesar el código QR';
          setScanError(msg);
        });
    },
    [addScanResult, playBeep],
  );

  const scanFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) return;

    const detector = detectorRef.current;
    if (detector) {
      if (scanInFlightRef.current) return;
      scanInFlightRef.current = true;
      detector
        .detect(video)
        .then((codes) => {
          const value = codes[0]?.rawValue;
          if (value) handleDetectedCode(value);
        })
        .catch(() => undefined)
        .finally(() => {
          scanInFlightRef.current = false;
        });
      return;
    }

    const canvas = canvasRef.current;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!canvas || width === 0 || height === 0) return;

    const scale = Math.min(1, MAX_SCAN_WIDTH / width);
    const scanWidth = Math.round(width * scale);
    const scanHeight = Math.round(height * scale);

    canvas.width = scanWidth;
    canvas.height = scanHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, scanWidth, scanHeight);
    const imageData = ctx.getImageData(0, 0, scanWidth, scanHeight);
    const code = jsQR(imageData.data, scanWidth, scanHeight, { inversionAttempts: 'dontInvert' });

    if (code) handleDetectedCode(code.data);
  }, [handleDetectedCode]);

  const stopCamera = useCallback(() => {
    if (scanTimerRef.current !== null) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
    }
  }, []);

  const startCamera = useCallback(async () => {
    stopCamera();

    try {
      if (!detectorRef.current && 'BarcodeDetector' in window) {
        detectorRef.current = new BarcodeDetector({ formats: ['qr_code'] });
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', '');
        try {
          await videoRef.current.play();
        } catch {
          // user interaction required before play — handled by user gesture
        }
      }

      scanTimerRef.current = window.setInterval(scanFrame, SCAN_INTERVAL_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'No se pudo acceder a la cámara';
      setCameraError(msg);
    }
  }, [scanFrame, stopCamera]);

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, [startCamera, stopCamera]);

  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  const handleFinish = () => {
    stopCamera();
    setShowReport(true);
  };

  const sendWhatsApp = () => {
    const total = scannedLabels.length;
    const ok = scannedLabels.filter((r) => !r.alreadyDispatched).length;
    const dup = scannedLabels.filter((r) => r.alreadyDispatched).length;

    let text = '📦 *Reporte de Escaneo*\n';
    text += `📅 ${new Date().toLocaleString('es-AR')}\n\n`;
    text += `*Resumen:*\n`;
    text += `Total: ${total}\n`;
    text += `Despachadas: ${ok}\n`;
    text += `Ya despachadas: ${dup}\n\n`;
    text += `*Detalle:*\n`;
    scannedLabels.forEach((r, i) => {
      text += `${i + 1}. ${r.externalReference} → ${r.alreadyDispatched ? '⚠️ Ya despachada' : '✅ Despachada'}\n`;
    });

    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  };

  const downloadPdf = () => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFontSize(18);
    doc.text('Reporte de Escaneo', pageWidth / 2, 20, { align: 'center' });

    doc.setFontSize(10);
    doc.text(`Fecha: ${new Date().toLocaleString('es-AR')}`, 14, 30);

    const total = scannedLabels.length;
    const ok = scannedLabels.filter((r) => !r.alreadyDispatched).length;
    const dup = scannedLabels.filter((r) => r.alreadyDispatched).length;

    doc.setFontSize(11);
    doc.text(`Total: ${total}  |  Despachadas: ${ok}  |  Ya despachadas: ${dup}`, 14, 38);

    autoTable(doc, {
      startY: 45,
      head: [['#', 'ID', 'Referencia', 'Estado', 'Hora']],
      body: scannedLabels.map((r, i) => [
        String(i + 1),
        r.labelId.slice(0, 8),
        r.externalReference,
        r.alreadyDispatched ? 'Ya despachada' : 'Despachada',
        r.scannedAt,
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [25, 118, 210] },
    });

    doc.save('reporte-escaneo.pdf');
  };

  if (showReport) {
    const total = scannedLabels.length;
    const ok = scannedLabels.filter((r) => !r.alreadyDispatched).length;
    const dup = scannedLabels.filter((r) => r.alreadyDispatched).length;

    return (
      <Box
        sx={{
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default',
          overflow: 'hidden',
        }}
      >
        <Box sx={{ bgcolor: 'background.paper', px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Reporte de Escaneo
          </Typography>
        </Box>

        <Box sx={{ flex: 1, overflow: 'auto', px: 2, py: 2 }}>
          <Stack spacing={2}>
            <Stack direction="row" spacing={2} sx={{ justifyContent: 'center' }}>
              <Box
                sx={{
                  textAlign: 'center',
                  bgcolor: 'background.paper',
                  borderRadius: 2,
                  p: 2,
                  flex: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Typography variant="h4" sx={{ fontWeight: 700, color: 'primary.main' }}>
                  {total}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Total
                </Typography>
              </Box>
              <Box
                sx={{
                  textAlign: 'center',
                  bgcolor: 'background.paper',
                  borderRadius: 2,
                  p: 2,
                  flex: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Typography variant="h4" sx={{ fontWeight: 700, color: 'success.main' }}>
                  {ok}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Despachadas
                </Typography>
              </Box>
              <Box
                sx={{
                  textAlign: 'center',
                  bgcolor: 'background.paper',
                  borderRadius: 2,
                  p: 2,
                  flex: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Typography variant="h4" sx={{ fontWeight: 700, color: 'warning.main' }}>
                  {dup}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Ya despachadas
                </Typography>
              </Box>
            </Stack>

            <Typography variant="subtitle2" color="text.secondary">
              Detalle de etiquetas escaneadas
            </Typography>

            <List dense>
              {scannedLabels.map((r, i) => (
                <ListItem
                  key={`${r.labelId}-${i}`}
                  sx={{
                    bgcolor: 'background.paper',
                    borderRadius: 2,
                    mb: 0.5,
                    border: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <ListItemText
                    primary={`${i + 1}. ${r.externalReference}`}
                    secondary={r.scannedAt}
                    slotProps={{ primary: { sx: { fontWeight: 600 } } }}
                  />
                  <Chip
                    icon={
                      r.alreadyDispatched ? (
                        <ErrorIcon fontSize="small" />
                      ) : (
                        <CheckCircleIcon fontSize="small" />
                      )
                    }
                    label={r.alreadyDispatched ? 'Ya despachada' : 'Despachada'}
                    color={r.alreadyDispatched ? 'warning' : 'success'}
                    size="small"
                    variant="outlined"
                  />
                </ListItem>
              ))}
            </List>
          </Stack>
        </Box>

        <Box
          sx={{
            bgcolor: 'background.paper',
            borderTop: '1px solid',
            borderColor: 'divider',
            px: 2,
            py: 1.5,
            pb: 3,
          }}
        >
          <Stack direction="row" spacing={2}>
            <Button
              fullWidth
              variant="contained"
              color="success"
              size="large"
              startIcon={<ShareIcon />}
              onClick={sendWhatsApp}
            >
              WhatsApp
            </Button>
            <Button
              fullWidth
              variant="contained"
              size="large"
              startIcon={<PictureAsPdfIcon />}
              onClick={downloadPdf}
            >
              PDF
            </Button>
          </Stack>
          <Button
            fullWidth
            variant="text"
            size="small"
            startIcon={<HomeIcon />}
            onClick={() => navigate('/picker')}
            sx={{ mt: 1 }}
          >
            Volver al inicio
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: '#000',
        overflow: 'hidden',
      }}
    >
      <Box sx={{ bgcolor: 'background.paper', px: 2, py: 1.5 }}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
            <Button
              variant="text"
              size="small"
              onClick={() => navigate('/picker')}
              sx={{ minWidth: 'auto', p: 0.5 }}
            >
              <HomeIcon />
            </Button>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Escanear Etiquetas
            </Typography>
          </Stack>
          <Chip
            label={scannedLabels.length}
            color={scannedLabels.length > 0 ? 'success' : 'default'}
            size="small"
          />
        </Stack>
      </Box>

      <Box
        sx={{
          flex: isSmallHeight ? 1 : '0 0 auto',
          bgcolor: '#000',
          position: 'relative',
          display: 'flex',
          justifyContent: 'center',
          alignItems: isSmallHeight ? 'center' : 'flex-start',
        }}
      >
        <Box
          sx={{
            position: 'relative',
            width: '100%',
            maxWidth: 420,
            aspectRatio: '3 / 4',
            overflow: 'hidden',
            bgcolor: '#000',
            maxHeight: isSmallHeight ? '100%' : 'none',
          }}
        >
          <Box
            component="video"
            ref={videoRef}
            playsInline
            muted
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
          <Box
            component="canvas"
            ref={canvasRef}
            sx={{ display: 'none' }}
          />
          {/* Square overlay */}
          <Box
            sx={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 200,
              height: 200,
              border: '3px solid',
              borderColor: scanSuccess ? '#4caf50' : 'rgba(255,255,255,0.7)',
              backgroundColor: scanSuccess ? 'rgba(76, 175, 80, 0.2)' : 'transparent',
              borderRadius: 2,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
              pointerEvents: 'none',
              transition: 'all 0.2s',
            }}
          />
        </Box>
        {cameraError && (
          <Alert severity="error" sx={{ position: 'absolute', bottom: 0, left: 0, right: 0, m: 1 }}>
            {cameraError}
          </Alert>
        )}
      </Box>

      {!isSmallHeight && (
        <Box
          sx={{
            flex: 1,
            bgcolor: 'background.default',
            overflow: 'auto',
            px: 1,
            pb: 10,
          }}
        >
          {scannedLabels.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
            <Typography variant="body2">
              Escanea un código QR para comenzar
            </Typography>
          </Box>
        ) : (
          <List dense>
            {scannedLabels.map((r, i) => (
              <ListItem
                key={`${r.labelId}-${i}`}
                sx={{
                  bgcolor: 'background.paper',
                  borderRadius: 2,
                  mb: 0.5,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <ListItemText
                  primary={r.externalReference}
                  secondary={r.scannedAt}
                  slotProps={{ primary: { sx: { fontWeight: 600 } } }}
                />
                <Chip
                  icon={
                    r.alreadyDispatched ? (
                      <ErrorIcon fontSize="small" />
                    ) : (
                      <CheckCircleIcon fontSize="small" />
                    )
                  }
                  label={r.alreadyDispatched ? 'Ya despachada' : 'Despachada'}
                  color={r.alreadyDispatched ? 'warning' : 'success'}
                  size="small"
                  variant="outlined"
                />
              </ListItem>
            ))}
          </List>
        )}
        </Box>
      )}

      <Box
        sx={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          bgcolor: 'background.paper',
          borderTop: '1px solid',
          borderColor: 'divider',
          px: 2,
          py: 1.5,
          pb: 3,
        }}
      >
        <Stack direction="row" spacing={2}>
          <Button
            fullWidth
            variant="contained"
            color="error"
            size="large"
            startIcon={<StopIcon />}
            onClick={handleFinish}
            disabled={scannedLabels.length === 0}
          >
            Finalizar ({scannedLabels.length})
          </Button>
        </Stack>
      </Box>

      <Snackbar
        open={!!scanError}
        autoHideDuration={3500}
        onClose={() => setScanError(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert severity="error" variant="filled" onClose={() => setScanError(null)}>
          {scanError}
        </Alert>
      </Snackbar>

      <Snackbar
        open={!!alreadyDispatchedNotice}
        autoHideDuration={3500}
        onClose={() => setAlreadyDispatchedNotice(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert severity="warning" variant="filled" onClose={() => setAlreadyDispatchedNotice(null)}>
          {alreadyDispatchedNotice} ya fue despachada
        </Alert>
      </Snackbar>

      <Snackbar
        open={!!alreadyScannedNotice}
        autoHideDuration={3500}
        onClose={() => setAlreadyScannedNotice(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert severity="info" variant="filled" onClose={() => setAlreadyScannedNotice(null)}>
          {alreadyScannedNotice} ya fue escaneada
        </Alert>
      </Snackbar>
    </Box>
  );
}
