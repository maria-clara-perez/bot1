import * as baileys from '@whiskeysockets/baileys';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import fetch from 'node-fetch';

// Configuración de rutas
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authPath = path.join(__dirname, './auth');

// Configuración de Supabase
const SUPABASE_URL = 'https://ynapmbdsfdumjsonelfb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluYXBtYmRzZmR1bWpzb25lbGZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzIwODU0NDMsImV4cCI6MjA0NzY2MTQ0M30.djf1-kby_hiJXJ9oHQzxuavFr5X5q3D6dVclL-LFd2k';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Configuración inicial del bot
let isConnected = false;
let processedMessages = new Set();
const linksToShare = ['https://chat.whassapy.com/', 'https://chat.whassapy.online/'];
let currentLinkIndex = 0;

// Objeto para contar los mensajes por grupo
let groupMessageCount = {};

// Configuración del bucket de Supabase
const storageBucket = 'auth-bucket'; // Nombre del bucket
const storagePath = 'auth/'; // Carpeta dentro del bucket para almacenar los archivos

// Generar hash MD5
const generateHashMD5 = (state) => {
  const stateString = JSON.stringify(state); // Convierte el objeto en una cadena
  return crypto.createHash('md5').update(stateString).digest('hex'); // Genera el hash
};

// Obtener última sesión guardada desde Supabase Storage
const getLastSessionFromSupabase = async () => {
  const { data, error } = await supabase
    .storage
    .from(storageBucket)
    .list(storagePath, { limit: 1, offset: 0, sortBy: { column: 'created_at', order: 'desc' } });

  if (error || data.length === 0) {
    console.error('Error al obtener la sesión desde Supabase Storage:', error);
    return null;
  }

  const filePath = `${storagePath}${data[0].name}`;
  const { signedURL, error: downloadError } = await supabase
    .storage
    .from(storageBucket)
    .createSignedUrl(filePath, 60);

  if (downloadError || !signedURL) {
    console.error('Error al obtener el archivo desde Supabase Storage:', downloadError);
    return null;
  }

  const response = await fetch(signedURL);
  const stateString = await response.text();
  return JSON.parse(stateString);
};

// Guardar sesión en Supabase
const saveSessionToSupabase = async (state) => {
  try {
    const sessionString = JSON.stringify(state);  // Convierte el estado en una cadena JSON
    const hash = generateHashMD5(state);  // O puedes generar un hash MD5 para los archivos de sesión

    // Carga el estado en Supabase Storage
    const { data, error } = await supabase
      .storage
      .from(storageBucket)
      .upload(`auth/${hash}.json`, Buffer.from(sessionString), {
        cacheControl: '3600',
        upsert: true  // Reemplazar si ya existe
      });

    if (error) {
      console.error('Error al guardar la sesión en Supabase:', error);
    } else {
      console.log('Sesión guardada exitosamente en Supabase:', data);
    }
  } catch (error) {
    console.error('Error al guardar la sesión:', error);
  }
};

// Compartir un enlace como reenviado
const shareLinkAsForwarded = async (socket, chatId = null) => {
  try {
    const linkToSend = linksToShare[currentLinkIndex];
    const message = {
      text: linkToSend, // Texto del mensaje (URL)
      forwardingScore: 100, // Indica que el mensaje ha sido reenviado
      isForwarded: true, // Marca el mensaje como reenviado
    };

    if (chatId) {
      await socket.sendMessage(chatId, message);
      console.log(`Enlace reenviado al chat ${chatId}: ${linkToSend}`);
    }
    currentLinkIndex = (currentLinkIndex + 1) % linksToShare.length; // Cambiar al siguiente enlace
  } catch (error) {
    console.error('Error al compartir el enlace como reenviado:', error);
  }
};

// Función principal para iniciar el bot
const startBot = async () => {
  const lastSession = await getLastSessionFromSupabase();

  const { state, saveCreds } = await baileys.useMultiFileAuthState(authPath, lastSession);

  const socket = baileys.makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['Bot', 'Chrome', '10.0'],
    timeoutMs: 60_000,
  });

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== baileys.DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('Intentando reconectar...');
        startBot();
      } else {
        console.log('Conexión cerrada, no se reconectará.');
      }
    } else if (connection === 'open') {
      if (!isConnected) {
        console.log('Conexión exitosa con WhatsApp');
        isConnected = true;
      }
    }
  });

  socket.ev.on('creds.update', async (state) => {
    saveCreds(state);
    await saveSessionToSupabase(state);  // Guarda la sesión en Supabase
  });

  // Manejo de mensajes
  socket.ev.on('messages.upsert', async (messageUpdate) => {
    for (const msg of messageUpdate.messages) {
      if (!msg.message) continue;

      const messageId = msg.key.id;

      // Evitar procesar el mismo mensaje varias veces
      if (processedMessages.has(messageId)) {
        continue;
      }
      processedMessages.add(messageId);

      const chatId = msg.key.remoteJid;
      const userMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

      if (userMessage) {
        // Contabilizar el mensaje en el grupo correspondiente
        if (!groupMessageCount[chatId]) {
          groupMessageCount[chatId] = 0;
        }
        groupMessageCount[chatId]++;
        console.log(`Mensajes recibidos en el grupo ${chatId}: ${groupMessageCount[chatId]}`);

        // Verificar si el contador alcanza el límite de 10 mensajes en el grupo
        if (groupMessageCount[chatId] >= 10) {
          await shareLinkAsForwarded(socket, chatId); // Enviar enlace como reenviado
          groupMessageCount[chatId] = 0; // Reiniciar contador después del envío
        }
      }

      // Limpiar el mensaje del set después de un tiempo
      setTimeout(() => processedMessages.delete(messageId), 60 * 1000);
    }
  });
};
// Función para borrar sesiones antiguas en Supabase cada 20 minutos
const deleteOldSessionsFromSupabase = async () => {
  try {
    // Listar todos los archivos en el bucket de sesiones
    const { data, error } = await supabase
      .storage
      .from(storageBucket)
      .list(storagePath, { limit: 100, offset: 0 });

    if (error) {
      console.error('Error al listar las sesiones en Supabase:', error);
      return;
    }

    // Recorrer los archivos y eliminarlos
    for (const file of data) {
      const filePath = `${storagePath}${file.name}`;
      const { error: deleteError } = await supabase
        .storage
        .from(storageBucket)
        .remove([filePath]);

      if (deleteError) {
        console.error(`Error al eliminar la sesión ${filePath}:`, deleteError);
      } else {
        console.log(`Sesión eliminada exitosamente: ${filePath}`);
      }
    }
  } catch (error) {
    console.error('Error al borrar las sesiones:', error);
  }
};

// Eliminar sesiones cada 20 minutos (1200000 ms)
setInterval(deleteOldSessionsFromSupabase, 1200000);


// Iniciar servidor Express
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('WhatsApp Bot está funcionando.');
});

app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto ${port}`);
});

// Iniciar el bot
startBot();
