<template>
  <q-dialog v-model="isOpen">
    <q-card class="pdf-modal-card">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">{{ fileName }}</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="q-pt-md">
        <!-- Error message -->
        <div v-if="errorMessage" class="error-message q-mb-md">
          <q-banner rounded class="bg-negative text-white">
            <template v-slot:avatar>
              <q-icon name="error" />
            </template>
            {{ errorMessage }}
          </q-banner>
        </div>

        <div v-if="pdfUrl && !errorMessage" class="pdf-container">
          <VuePDF
            :pdf="pdfDocument"
            :page="currentPage"
            :scale="scale"
            :textLayer="true"
            class="pdf-viewer"
            @loaded="onPdfLoaded"
            @error="onPdfError"
          />
          
          <!-- PDF Controls -->
          <div class="pdf-controls q-mt-md">
            <q-btn 
              icon="chevron_left" 
              @click="previousPage" 
              :disable="currentPage <= 1"
              size="sm"
              color="primary"
            />
            <span class="page-info">{{ currentPage }} / {{ totalPages }}</span>
            <q-btn 
              icon="chevron_right" 
              @click="nextPage" 
              :disable="currentPage >= totalPages"
              size="sm"
              color="primary"
            />
            
            <!-- Page number input -->
            <div class="page-input-container">
              <q-input
                v-model.number="pageInput"
                type="number"
                :min="1"
                :max="totalPages"
                dense
                outlined
                class="page-input"
                @keyup.enter="goToPage"
                @blur="goToPage"
              />
              <q-btn 
                icon="arrow_forward" 
                @click="goToPage" 
                size="sm"
                flat
                class="go-button"
              />
            </div>
            
            <q-btn 
              icon="zoom_out" 
              @click="zoomOut" 
              size="sm"
              color="primary"
            />
            <span class="scale-info">{{ Math.round(scale * 100) }}%</span>
            <q-btn 
              icon="zoom_in" 
              @click="zoomIn" 
              size="sm"
              color="primary"
            />
          </div>
        </div>

        <!-- No PDF state -->
        <div v-else-if="!errorMessage" class="no-pdf">
          <q-icon name="description" size="40px" color="grey" />
          <p>No PDF to display</p>
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { VuePDF } from '@tato30/vue-pdf';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
if (typeof window !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';
}

interface Props {
  modelValue: boolean;
  file?: {
    fileUrl?: string;
    bucketKey?: string;
    originalFile?: File;
    name?: string;
  };
  initialPage?: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
});

const fileName = computed(() => props.file?.name || 'PDF Viewer');

// Helper to check if file is actually a PDF (by name or by bucketKey/URL, so display names without .pdf still work)
const isPdfFile = computed(() => {
  if (!props.file) return false;
  const name = (props.file.name || '').toLowerCase();
  if (name.endsWith('.pdf')) return true;
  const bucketKey = (props.file.bucketKey || '').toLowerCase();
  if (bucketKey && bucketKey.endsWith('.pdf')) return true;
  const url = (props.file.fileUrl || '').toLowerCase();
  if (url.endsWith('.pdf') || url.includes('/proxy-pdf/')) return true;
  return false;
});

// Reactive state
const currentPage = ref(1);
const totalPages = ref(0);
const scale = ref(1.0);
const pageInput = ref('');
const pdfDocument = ref<any>(null);
const isLoading = ref(false);
const errorMessage = ref<string>('');

// Computed
const pdfUrl = computed(() => {
  if (!props.file) {
    return '';
  }
  
  // Use bucketKey to construct proxy URL for imported files (avoids CORS)
  if (props.file.bucketKey) {
    return `/api/files/proxy-pdf/${props.file.bucketKey}`;
  }
  
  if (props.file.fileUrl) {
    return props.file.fileUrl;
  }
  
  if (props.file.originalFile instanceof File) {
    return URL.createObjectURL(props.file.originalFile);
  }
  
  return '';
});

// Methods
const loadPdfDocument = async () => {
  // Validate that this is actually a PDF file
  if (!isPdfFile.value) {
    errorMessage.value = `This file (${props.file?.name || 'unknown'}) is not a PDF file. Please use the text viewer instead.`;
    pdfDocument.value = null;
    totalPages.value = 0;
    isLoading.value = false;
    return;
  }

  if (!pdfUrl.value) {
    errorMessage.value = 'No file URL available';
    pdfDocument.value = null;
    totalPages.value = 0;
    isLoading.value = false;
    return;
  }

  if (isLoading.value) {
    return;
  }

  try {
    isLoading.value = true;
    errorMessage.value = '';
    const loadingTask = pdfjsLib.getDocument(pdfUrl.value);
    pdfDocument.value = loadingTask;
    const pdf = await loadingTask.promise;
    totalPages.value = pdf.numPages || 0;
  } catch (error: any) {
    errorMessage.value = error?.message || 'Failed to load PDF. This file may not be a valid PDF.';
    pdfDocument.value = null;
    totalPages.value = 0;
  } finally {
    isLoading.value = false;
  }
};

const onPdfLoaded = (pdf: any) => {
  if (totalPages.value === 0 && pdf.numPages && pdf.numPages > 0) {
    totalPages.value = pdf.numPages;
  }
};

const onPdfError = (_err: any) => {
  totalPages.value = 0;
};

const previousPage = () => {
  if (currentPage.value > 1) {
    currentPage.value--;
  }
};

const nextPage = () => {
  if (totalPages.value === 0) {
    return;
  }
  if (currentPage.value < totalPages.value) {
    currentPage.value++;
  }
};

const zoomIn = () => {
  scale.value = Math.min(scale.value + 0.25, 3.0);
};

const zoomOut = () => {
  scale.value = Math.max(scale.value - 0.25, 0.5);
};

const goToPage = () => {
  const targetPage = Number(pageInput.value);
  
  if (targetPage >= 1 && targetPage <= totalPages.value) {
    currentPage.value = targetPage;
    pageInput.value = '';
  } else {
    pageInput.value = '';
  }
};

// Watch for file changes
watch(() => props.file, (newFile) => {
  if (newFile && !isLoading.value) {
    currentPage.value = props.initialPage && props.initialPage > 0 ? props.initialPage : 1;
    totalPages.value = 0;
    errorMessage.value = '';
    loadPdfDocument();
  }
}, { immediate: true });

// Watch for modal opening and initialPage changes
watch(() => [props.modelValue, props.initialPage], ([isOpen, initialPage]) => {
  if (isOpen && props.file && initialPage !== undefined && typeof initialPage === 'number' && initialPage > 0) {
    // Wait for PDF to load, then set the page
    const checkAndSetPage = () => {
      if (totalPages.value > 0) {
        const pageNum = Number(initialPage);
        if (pageNum <= totalPages.value) {
          currentPage.value = pageNum;
          pageInput.value = String(pageNum);
        }
      } else {
        // PDF not loaded yet, try again
        setTimeout(checkAndSetPage, 100);
      }
    };
    checkAndSetPage();
  }
});
</script>

<style scoped>
.pdf-modal-card {
  width: 90vw;
  height: 90vh;
  max-width: 90vw;
  max-height: 90vh;
}

.pdf-container {
  display: flex;
  flex-direction: column;
  height: 80vh;
  overflow: hidden;
}

.pdf-viewer {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: auto;
  position: relative;
}

.pdf-viewer :deep(.vue-pdf-embed) {
  width: 100% !important;
  height: auto !important;
  max-width: 100% !important;
  display: block !important;
}

.pdf-viewer :deep(.textLayer) {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
  opacity: 0.2;
  line-height: 1.0;
  pointer-events: auto;
}

.pdf-viewer :deep(.textLayer > span) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}

.pdf-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid #eee;
  flex-wrap: wrap;
}

.page-info {
  font-weight: 500;
  min-width: 60px;
  text-align: center;
}

.page-input-container {
  display: flex;
  align-items: center;
  gap: 4px;
}

.page-input {
  width: 60px;
}

.scale-info {
  font-weight: 500;
  min-width: 50px;
  text-align: center;
}

.no-pdf {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 400px;
  gap: 16px;
}
</style>

