#!/usr/bin/env python3
"""
Minimal Whisper STT server using faster-whisper.
Install: pip install faster-whisper flask
Usage:   python whisper_server.py [--model small.en] [--port 5051]
"""
import argparse, base64, os, sys, tempfile
from flask import Flask, request, jsonify

app = Flask(__name__)
model = None


def load_model(model_size):
    global model
    print(f'[Whisper] Loading model: {model_size}', flush=True)
    from faster_whisper import WhisperModel
    model = WhisperModel(model_size, device='cpu', compute_type='int8')
    print('[Whisper] Model ready', flush=True)


@app.route('/health')
def health():
    return jsonify({'status': 'ready' if model is not None else 'loading'})


@app.route('/transcribe', methods=['POST'])
def transcribe():
    if model is None:
        return jsonify({'error': 'Model not loaded'}), 503

    data = request.get_json(force=True) or {}
    audio_b64 = data.get('audio', '')
    fmt = data.get('format', 'webm')

    if not audio_b64:
        return jsonify({'error': 'No audio provided'}), 400

    try:
        audio_bytes = base64.b64decode(audio_b64)
        with tempfile.NamedTemporaryFile(suffix=f'.{fmt}', delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name
        try:
            segments, _ = model.transcribe(tmp_path, beam_size=5)
            text = ' '.join(seg.text.strip() for seg in segments).strip()
            return jsonify({'text': text})
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as e:
        print(f'[Whisper] Transcription error: {e}', flush=True)
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default=os.environ.get('WHISPER_MODEL', 'small.en'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('WHISPER_PORT', '5051')))
    args = parser.parse_args()
    load_model(args.model)
    app.run(host='127.0.0.1', port=args.port, debug=False)
