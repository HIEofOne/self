<template>
  <div class="lists-container q-pa-md">
    <div class="row items-center q-mb-md">
      <div class="col">
        <div class="text-h4">Lists</div>
        <div class="text-caption text-grey">Extract structured lists from your PDF files</div>
      </div>
      <div class="col-auto">
        <q-btn
          flat
          icon="arrow_back"
          label="Back to Chat"
          @click="$emit('back-to-chat')"
        />
      </div>
    </div>

    <!-- Current Medications - Always visible -->
    <q-card class="q-mb-md">
      <q-card-section>
        <div class="text-h6 q-mb-md">{{ currentMedicationsBlockTitle }}</div>
        
        <!-- Initial loading spinner (covers flash before medications state is known) -->
        <div v-if="isInitialMedsLoading && !isEditingCurrentMedications" class="q-pa-md text-center">
          <q-spinner-dots color="primary" size="2em" />
          <div class="text-caption text-grey-7 q-mt-sm">Loading medications...</div>
        </div>

        <!-- Loading State with Progress Messages -->
        <div v-else-if="isLoadingCurrentMedications" class="q-pa-md">
          <div class="text-center q-mb-md">
            <q-spinner color="primary" size="2em" />
          </div>
          <div class="text-body2 text-center text-grey-7">
            <div v-if="currentMedicationsStatus === 'reviewing'">
              Private AI is reviewing your Medication Records to identify current prescriptions...
              <div class="text-caption q-mt-sm">This could take up to 30 seconds.</div>
            </div>
            <div v-else-if="currentMedicationsStatus === 'consulting'">
              Private AI is analyzing your records to identify current medications...
              <div class="text-caption q-mt-sm">This could take up to 30 seconds.</div>
            </div>
            <div v-else-if="currentMedicationsStatus === 'waiting_summary'">
              Extracting Current Medications from your Patient Summary...
            </div>
            <div v-else-if="currentMedicationsStatus === 'waiting'">
              Waiting for Private AI agent to finish setup...
              <div class="text-caption q-mt-sm">This could take up to 30 seconds.</div>
            </div>
            <div v-else>
              Processing your medications...
            </div>
          </div>
        </div>
        
        <!-- Display Mode -->
        <div v-else-if="!isEditingCurrentMedications && currentMedications">
          <div class="text-body2" style="white-space: pre-wrap;">{{ cleanedCurrentMedications }}</div>
          <div class="text-caption text-grey-7 q-mt-md q-pt-md" style="border-top: 1px solid #e0e0e0;">
            Please edit this AI suggestion to reflect your actual prescription drug use.
          </div>
        </div>
        
        <!-- Empty State -->
        <div v-else-if="!isEditingCurrentMedications && !currentMedications" class="text-body2 text-grey-7 q-pa-md text-center">
          <div v-if="wizardPreparingMeds">
            <q-spinner color="primary" size="1.5em" class="q-mr-sm" />
            Current medications are being prepared...
          </div>
          <div v-else-if="hasMedicationRecords">
            No current medications identified yet. Click "Generate" to review your medication records.
          </div>
          <div v-else>
            No medication records found. Upload a health record file to extract medication information.
          </div>
          <div v-if="appleHealthFileInfo && !wizardPreparingMeds" class="q-mt-md">
            <q-btn
              color="primary"
              icon="create"
              :label="`Create categories list and current medications from ${appleHealthFileInfo.fileName}`"
              @click="processInitialFile(appleHealthFileInfo)"
              :loading="isProcessing"
            />
          </div>
        </div>
        
        <!-- Edit Mode -->
        <div v-else>
          <textarea 
            v-model="editingCurrentMedications" 
            rows="8"
            class="full-width q-pa-sm"
            style="border: 1px solid #ccc; border-radius: 4px; resize: vertical; font-family: inherit;"
          />
          <div class="q-mt-sm">
            <q-btn
              size="sm"
              icon="save"
              color="primary"
              label="Save"
              @click="saveCurrentMedications"
              :loading="isSavingCurrentMedications"
            />
            <q-btn
              size="sm"
              icon="close"
              color="grey-7"
              label="Cancel"
              @click="cancelEditingCurrentMedications"
              class="q-ml-sm"
            />
          </div>
        </div>
        
        <div class="q-mt-sm">
          <q-btn
            v-if="!isEditingCurrentMedications && !currentMedications && hasMedicationRecords && !wizardAutoFlow && !wizardPreparingMeds"
            flat
            dense
            icon="play_arrow"
            label="Generate"
            color="primary"
            @click="loadCurrentMedications(true)"
            :loading="isLoadingCurrentMedications"
            class="q-mr-sm"
          />
          <q-btn
            v-if="!isEditingCurrentMedications && currentMedications"
            flat
            dense
            icon="edit"
            label="Edit"
            @click="startEditingCurrentMedications"
            class="q-mr-sm"
            :class="{ 'verify-highlight': needsVerifyAction }"
          />
          <q-btn
            v-if="!isEditingCurrentMedications && currentMedications"
            flat
            dense
            icon="verified"
            label="Verify"
            @click="handleVerifyCurrentMedications"
            class="q-mr-sm"
            :class="{ 'verify-highlight': needsVerifyAction }"
          />
          <q-btn
            v-if="hasMedicationRecords && !isEditingCurrentMedications && currentMedications"
            flat
            dense
            icon="refresh"
            label="Refresh"
            @click="handleRefreshCurrentMedications"
            :loading="isLoadingCurrentMedications"
          />
        </div>
      </q-card-section>
    </q-card>

    <!-- Refresh Confirmation Dialog -->
    <q-dialog v-model="showRefreshConfirmDialog" persistent>
      <q-card style="min-width: 350px">
        <q-card-section>
          <div class="text-h6">Confirm Refresh</div>
        </q-card-section>
        <q-card-section>
          You will need to review and edit your current medications again.
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="CANCEL" color="grey-7" v-close-popup />
          <q-btn flat label="REFRESH" color="primary" @click="confirmRefreshCurrentMedications" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Show Summary Dialog (after saving Current Medications) -->
    <q-dialog v-model="showSummaryDialog" persistent>
      <q-card style="min-width: 400px">
        <q-card-section>
          <div class="text-h6">Current Medications Saved</div>
        </q-card-section>
        <q-card-section>
          The Current Medications have changed. Would you like to update the Patient Summary to reflect the changes?
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="NOT NOW" color="grey-7" v-close-popup />
          <q-btn flat label="UPDATE SUMMARY" color="primary" @click="handleShowSummary" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Verify Current Medications Dialog -->
    <q-dialog v-model="showVerifyPrompt" persistent>
      <q-card style="min-width: 380px">
        <q-card-section>
          <div class="text-h6">Please verify or edit your Current Medications</div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="OK" color="primary" @click="handleVerifyDismissed" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Error State -->
    <q-banner v-if="error" rounded class="bg-negative text-white q-mb-md">
      <template v-slot:avatar>
        <q-icon name="error" />
      </template>
      {{ error }}
    </q-banner>

    <!-- Results -->
    <div v-if="(pdfData || markdownContent) && !isProcessing">

      <!-- Categories Section -->
      <q-card v-if="!hasAppleHealthFile" class="q-mb-md">
        <q-card-section>
          <div class="text-body2 text-grey-7">
            Categories index currently requires an Apple Health Export PDF file.
          </div>
        </q-card-section>
      </q-card>
      <q-card v-else-if="categoriesList.length > 0" class="q-mb-md">
        <q-card-section>
          <div class="text-h6 q-mb-md">Categories</div>
          <q-list bordered separator>
            <q-expansion-item
              v-for="(category, index) in categoriesList" 
              :key="index"
              :label="category.name"
              :default-opened="category.expanded"
              @show="expandedCategories.add(category.name)"
              @hide="expandedCategories.delete(category.name)"
              header-class="text-primary"
            >
              <template v-slot:header>
                <q-item-section>
                  <q-item-label>{{ category.name }}</q-item-label>
                  <q-item-label caption>
                    starts on 
                    <a 
                      href="#" 
                      @click.stop.prevent="handleCategoryPageClick(category.page)"
                      class="text-primary"
                      style="text-decoration: underline; cursor: pointer;"
                    >
                      page {{ category.page }}
                    </a>
                    <span v-if="category.observationCount > 0" class="q-ml-sm">
                      • {{ category.observationCount }} Observation{{ category.observationCount !== 1 ? 's' : '' }}
                    </span>
                  </q-item-label>
                </q-item-section>
              </template>
              
              <q-card>
                <q-card-section>
                  <div v-if="!category.observations || category.observations.length === 0" class="text-grey q-pa-md text-center">
                    No observations found for this category
                  </div>
                  <q-list v-else dense>
                    <template v-for="(obs, obsIndex) in category.observations" :key="obsIndex">
                      <q-item class="q-px-sm">
                        <q-item-section>
                          <q-item-label class="text-body2">
                            <span 
                              v-html="obs.display.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')"
                              @click="handleObservationClick($event, obs.page)"
                            ></span>
                          </q-item-label>
                        </q-item-section>
                      </q-item>
                      <!-- Display out of range lines for Lab Results -->
                      <q-item 
                        v-for="(oorLine, oorIndex) in obs.outOfRangeLines" 
                        :key="`oor-${obsIndex}-${oorIndex}`"
                        class="q-px-sm q-pl-lg"
                      >
                        <q-item-section>
                          <q-item-label class="text-body2 text-negative">
                            {{ fixOutOfRangeText(oorLine.trim()) }}
                          </q-item-label>
                        </q-item-section>
                      </q-item>
                    </template>
                  </q-list>
                </q-card-section>
              </q-card>
            </q-expansion-item>
          </q-list>
        </q-card-section>
      </q-card>

      <!-- Markdown Display (hidden by default) -->
      <q-card v-if="markdownContent && showMarkdownContent" class="q-mb-md">
        <q-card-section>
          <div class="text-h6 q-mb-md">Markdown Content</div>
          <div v-if="markdownBucketKey" class="text-caption text-grey q-mb-sm">
            <q-icon name="folder" size="xs" /> Saved to: <code>{{ markdownBucketKey }}</code>
          </div>
          <div class="markdown-preview q-pa-md" style="background: #f5f5f5; border-radius: 4px; max-height: 600px; overflow-y: auto;">
            <pre style="white-space: pre-wrap; font-family: monospace; font-size: 12px; margin: 0;">{{ markdownContent }}</pre>
          </div>
        </q-card-section>
      </q-card>

      <!-- LISTS SOURCE FILE (moved to bottom) -->
      <q-card v-if="pdfData || markdownBucketKey" class="q-mb-md">
        <q-card-section>
          <div class="row items-center">
            <div class="col">
              <div class="text-h6">LISTS SOURCE FILE</div>
              <div class="q-mt-sm">
                <div v-if="pdfData?.totalPages"><strong>Total Pages:</strong> {{ pdfData.totalPages }}</div>
                <div v-if="selectedFileName"><strong>File:</strong> {{ selectedFileName }}</div>
                <div v-if="markdownBucketKey" class="text-caption text-grey q-mt-xs">
                  <q-icon name="folder" size="xs" /> Location: <code>{{ markdownBucketKey }}</code>
                </div>
              </div>
            </div>
            <div class="col-auto">
              <div class="row q-gutter-sm">
                <q-btn
                  color="secondary"
                  icon="file_upload"
                  label="REPLACE THE LISTS SOURCE FILE"
                  @click="replaceListsSourceFile"
                  :loading="isReplacingFile"
                />
                <q-btn
                  v-if="markdownContent"
                  color="primary"
                  icon="visibility"
                  :label="showMarkdownContent ? 'HIDE FILE MARKDOWN' : 'SHOW FILE MARKDOWN'"
                  @click="toggleMarkdownContent"
                />
                <q-btn
                  color="primary"
                  icon="download"
                  label="Download Markdown"
                  @click="downloadMarkdown"
                />
              </div>
            </div>
          </div>
        </q-card-section>
      </q-card>

      <!-- Category Items List (dynamic - shows currently selected category) -->
      <q-card v-if="currentCategoryDisplay" class="q-mb-md">
        <q-card-section>
          <div class="text-h6 q-mb-md">{{ currentCategoryDisplay }}</div>
          
          <div v-if="isLoadingCategoryItems" class="text-center q-pa-md">
            <q-spinner size="2em" color="primary" />
            <div class="q-mt-sm text-caption">Loading {{ currentCategoryDisplay.toLowerCase() }}...</div>
          </div>
          
          <div v-else-if="categoryItems.length === 0" class="text-center q-pa-md text-grey">
            No items found.
          </div>
          
          <q-list v-else bordered separator>
            <q-item 
              v-for="(item, index) in categoryItems" 
              :key="`${currentCategoryDisplay}-${item.id || item.name || index}-${index}`"
              clickable
              @click="copyItemToClipboard(item, currentCategoryDisplay)"
              class="cursor-pointer"
            >
              <q-item-section>
                <q-item-label 
                  class="text-body2"
                  v-if="currentCategoryDisplay && currentCategoryDisplay.toLowerCase().includes('medication')"
                  v-html="formatItemDescription(item, currentCategoryDisplay)"
                />
                <q-item-label 
                  v-else
                  class="text-body2"
                >
                  {{ formatItemDescription(item, currentCategoryDisplay) }}
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-item-label caption>
                  <span v-if="item.fileName" class="text-grey">{{ item.fileName }}</span>
                  <span v-if="item.page > 0" class="text-grey q-ml-sm">Page {{ item.page }}</span>
                </q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>
      </q-card>
    </div>
  </div>

  <!-- PDF Viewer Modal -->
  <PdfViewerModal
    v-model="showPdfViewer"
    :file="viewingPdfFile"
    :initial-page="pdfInitialPage"
  />
</template>

<script setup lang="ts">
import PdfViewerModal from './PdfViewerModal.vue';
import { ref, computed, onMounted, watch, onActivated, onDeactivated, nextTick } from 'vue';
import { useQuasar } from 'quasar';

const $q = useQuasar();

interface Props {
  userId: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'back-to-chat': [];
  'show-patient-summary': [];
  'current-medications-saved': [data: { value: string; edited: boolean }];
}>();


interface PdfPage {
  page: number;
  text: string;
  markdown: string;
  lineCount: number;
  itemCount: number;
}

interface MarkdownCategory {
  category: string;
  count: number;
}

interface ClinicalNote {
  id: string;
  type: string;
  author: string;
  category: string;
  created: string;
  date: string;
  fileName: string;
  page: number;
}

interface PdfData {
  totalPages: number;
  pages: PdfPage[];
  categories: MarkdownCategory[];
  fullMarkdown: string;
  categoryError?: string;
}

const selectedFileName = ref<string>('');
const isProcessing = ref(false);
const processingMessage = ref('');
const error = ref<string>('');
const pdfData = ref<PdfData | null>(null);
const categories = ref<MarkdownCategory[]>([]);
const activePageTab = ref<number>(1);
const hasSavedResults = ref(false);
const hasAppleHealthFile = ref(false);
const appleHealthFileInfo = ref<{ bucketKey: string; fileName: string } | null>(null);
const savedPdfBucketKey = ref<string | null>(null);
const savedResultsBucketKey = ref<string | null>(null);
const categoryProcessingStatus = ref<Record<string, { total: number; indexed: number; errors: string[] }>>({});
const currentCategoryDisplay = ref<string | null>(null);
const categoryItems = ref<any[]>([]);
const isLoadingCategoryItems = ref(false);
const hasInitialFile = ref(false);
const markdownContent = ref<string>('');
const markdownBucketKey = ref<string | null>(null);
const initialFileInfo = ref<{ bucketKey: string; fileName: string } | null>(null);
const categoriesList = ref<Array<{ 
  name: string; 
  page: number; 
  observationCount: number; 
  startLine?: number; 
  endLine?: number;
  observations?: Array<{ date: string; display: string; page?: number; lineCount?: number; outOfRangeLines?: string[] | undefined }>;
  expanded?: boolean;
}>>([]);
const expandedCategories = ref<Set<string>>(new Set());
const showPdfViewer = ref(false);
const viewingPdfFile = ref<{ bucketKey?: string; name?: string; fileUrl?: string; originalFile?: File } | undefined>(undefined);
const pdfInitialPage = ref<number | undefined>(undefined);
const currentMedications = ref<string | null>(null);
const isLoadingCurrentMedications = ref(false);
const isEditingCurrentMedications = ref(false);
const editingCurrentMedications = ref('');
/** When no Medication Records category is found, show this title and open block for editing. */
const currentMedicationsBlockTitle = ref('Current Medications');
const editingOriginalCurrentMedications = ref('');
const isSavingCurrentMedications = ref(false);
const isCurrentMedicationsEdited = ref(false);
const currentMedicationsStatus = ref<'reviewing' | 'consulting' | 'waiting' | 'waiting_summary' | ''>('');
const wizardAutoFlow = ref(false);
const wizardAutoFlowStorageKey = 'wizardMyListsAuto';
const wizardAutoStartPending = ref(false);
const wizardPreparingMeds = computed(() =>
  wizardAutoFlow.value &&
  !currentMedications.value &&
  (wizardAutoStartPending.value || isProcessing.value || isLoadingCurrentMedications.value || hasSavedResults.value || hasMedicationRecords.value)
);
const showSummaryDialog = ref(false);
const showRefreshConfirmDialog = ref(false);
const showMarkdownContent = ref(false);
const isReplacingFile = ref(false);
const showVerifyPrompt = ref(false);
const needsVerifyAction = ref(false);
const verifyPromptPending = ref(false);
/** Once the user dismisses the verify prompt this session, don't show it again until page reload. */
const medsDismissedThisSession = ref(false);
/** True until the initial medications fetch from the server completes (covers UI flash). */
const isInitialMedsLoading = ref(true);
const verifyStorageKey = computed(() => props.userId ? `verify-meds-${props.userId}` : null);
const waitForAgentReady = async () => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const statusResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
        credentials: 'include'
      });
      if (statusResponse.ok) {
        const statusResult = await statusResponse.json();
        if (statusResult?.agentReady) {
          return true;
        }
      }
    } catch (statusErr) {
      // ignore status errors during wait
    }
    currentMedicationsStatus.value = 'waiting';
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  return false;
};
const autoProcessAttempts = ref(0);

const checkInitialFile = async () => {
  try {
    const response = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    
    if (!response.ok) {
      return;
    }
    
    const result = await response.json();
    hasInitialFile.value = !!(result.initialFile && result.initialFile.bucketKey);
    
    if (result.initialFile && result.initialFile.bucketKey) {
      initialFileInfo.value = {
        bucketKey: result.initialFile.bucketKey,
        fileName: result.initialFile.fileName || 'Initial File'
      };
      return;
    }
    
    // Fallback: Try to get initial file from Lists markdown file name
    // The markdown file is usually named after the PDF (e.g., "Apple_Health_for_AG.md" -> "Apple_Health_for_AG.pdf")
    // The PDF should be in userId/KB/ folder (where KB is the KB name) for KB indexing
    if (!initialFileInfo.value && markdownBucketKey.value) {
      try {
        // Get KB name from the result we already fetched
        const kbName = result.kbName || null;
        
        // Extract PDF name from markdown bucket key
        // Format: userId/Lists/FileName.md
        const markdownKey = markdownBucketKey.value;
        const fileName = markdownKey.split('/').pop()?.replace(/\.md$/, '') || 'Initial File';
        const userId = markdownKey.split('/')[0];
        
        // Try different locations in order of likelihood:
        // 1. userId/KB/FileName.pdf (most likely - where it should be for KB indexing)
        // 2. userId/archived/FileName.pdf (if it was archived)
        // 3. userId/FileName.pdf (root level - least likely)
        const possiblePaths = [];
        if (kbName) {
          possiblePaths.push(`${userId}/${kbName}/${fileName}.pdf`);
        }
        possiblePaths.push(`${userId}/archived/${fileName}.pdf`);
        possiblePaths.push(`${userId}/${fileName}.pdf`);
        
        // Use the KB path if we have KB name, otherwise try archived, then root
        const pdfKey = possiblePaths[0]; // Start with most likely
        const displayFileName = fileName.replace(/_/g, ' ');
        
        initialFileInfo.value = {
          bucketKey: pdfKey,
          fileName: displayFileName
        };
        hasInitialFile.value = true;
      } catch (fallbackErr) {
        // Fallback failed - silently continue
      }
    }
  } catch (err) {
    // Error checking initial file - silently continue
  }
};

const loadAppleHealthStatus = async () => {
  if (!props.userId) return;
  try {
    const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}&source=saved`, {
      credentials: 'include'
    });
    if (!response.ok) return;
    const result = await response.json();
    const files = Array.isArray(result?.files) ? result.files : [];
    const appleFile = files.find((file: { isAppleHealth?: boolean }) => !!file?.isAppleHealth);
    hasAppleHealthFile.value = !!appleFile;
    appleHealthFileInfo.value = appleFile
      ? {
        bucketKey: appleFile.bucketKey,
        fileName: appleFile.fileName || appleFile.name || 'Apple Health Export'
      }
      : null;
  } catch (error) {
    // ignore errors
  }
};

const loadSavedResults = async () => {
  try {
    await loadAppleHealthStatus();
    // Check if Lists folder exists and has files
    const markdownResponse = await fetch('/api/files/lists/markdown', {
      credentials: 'include'
    });
    
    if (markdownResponse.ok) {
      const markdownResult = await markdownResponse.json();
      
      // If Lists folder doesn't exist or is empty, reset state
      if (!markdownResult.hasMarkdown) {
        hasSavedResults.value = false;
        pdfData.value = null;
        markdownContent.value = '';
        markdownBucketKey.value = null;
        savedPdfBucketKey.value = null;
        savedResultsBucketKey.value = null;
        selectedFileName.value = '';
        categories.value = [];
        categoryProcessingStatus.value = {};
        currentCategoryDisplay.value = null;
        categoryItems.value = [];
        
        // Clean up user document references to old lists
        try {
          await fetch('/api/files/lists/cleanup-user-doc', {
            method: 'POST',
            credentials: 'include'
          });
        } catch (cleanupErr) {
          console.warn('Failed to cleanup user document:', cleanupErr);
        }
        return;
      }
      
      // Markdown file exists - load it
      if (markdownResult.markdown) {
        markdownBucketKey.value = markdownResult.markdownBucketKey || null;
        hasSavedResults.value = true;
        
        // Load markdown and compute categories/observations on-the-fly
        const markedMarkdown = extractCategoriesFromMarkdown(markdownResult.markdown);
        markdownContent.value = markedMarkdown;
        countObservationsByPageRange(markdownContent.value);
        
        // Try to load initial file info (will use fallback if user document doesn't have it)
        if (!initialFileInfo.value) {
          await checkInitialFile();
        }
        
        // Ensure initialFileInfo is set for PDF viewing
        if (!initialFileInfo.value) {
          await checkInitialFile();
        }
        
        // Also try to load results.json if it exists
        const resultsResponse = await fetch('/api/files/lists/results', {
          credentials: 'include'
        });
        
        if (resultsResponse.ok) {
          const resultsResult = await resultsResponse.json();
          if (resultsResult.hasResults && resultsResult.results) {
            pdfData.value = {
              totalPages: resultsResult.results.totalPages,
              pages: resultsResult.results.pages,
              categories: resultsResult.results.categories || [],
              fullMarkdown: resultsResult.results.fullMarkdown,
              categoryError: resultsResult.results.categoryError
            };
            categories.value = resultsResult.results.categories || [];
            selectedFileName.value = resultsResult.results.fileName || '';
            savedResultsBucketKey.value = resultsResult.resultsBucketKey;
            
            if (resultsResult.results.pages && resultsResult.results.pages.length > 0) {
              activePageTab.value = resultsResult.results.pages[0].page;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error loading saved results:', err);
    // On error, reset state to allow fresh start
    hasSavedResults.value = false;
    pdfData.value = null;
    markdownContent.value = '';
  }
};

// reprocessPdf removed - no longer needed with initial file approach

const formatItemDescription = (item: any, categoryName: string): string => {
  if (categoryName.toLowerCase().includes('clinical notes')) {
    const parts: string[] = [];
    
    // Date first (from created field)
    if (item.created) {
      parts.push(item.created);
    }
    
    // Then Author
    if (item.author) {
      parts.push(item.author);
    }
    
    // Then Category (only if it's not "Clinical Note")
    if (item.category && item.category !== 'Clinical Note') {
      parts.push(item.category);
    }
    
    return parts.join(' ') || 'No details available';
  } else if (categoryName.toLowerCase().includes('medication')) {
    const parts: string[] = [];
    
    // Extract date without location (remove everything after semicolon or common location patterns)
    if (item.date) {
      let dateOnly = item.date.split(';')[0].trim();
      // Remove common location patterns if they appear after the date
      dateOnly = dateOnly.replace(/\s+Mass\s+General\s+Brigham.*$/i, '');
      dateOnly = dateOnly.replace(/\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+.*$/i, ''); // Remove patterns like "Location Name" (2+ capitalized words)
      parts.push(dateOnly);
    }
    
    // Add name and dosage in bold (HTML format)
    if (item.name || item.dosage) {
      const boldParts: string[] = [];
      if (item.name) boldParts.push(`<strong>${item.name}</strong>`);
      if (item.dosage) boldParts.push(`<strong>${item.dosage}</strong>`);
      if (boldParts.length > 0) {
        parts.push(boldParts.join(' '));
      }
    }
    
    // Add other fields if present (frequency, status) without prefixes
    if (item.frequency) parts.push(item.frequency);
    if (item.status) parts.push(item.status);
    
    return parts.join(' ') || 'No details available';
  }
  // Generic format for other categories
  return JSON.stringify(item).substring(0, 100) || 'No details available';
};

const copyItemToClipboard = async (item: any, categoryName: string) => {
  if (categoryName.toLowerCase().includes('clinical notes')) {
    await copyNoteToClipboard(item);
    return;
  }
  
  // For other categories, create a search query using original item data
  // For medications, use the original item data (with all info) for clipboard
  let description = '';
  if (categoryName.toLowerCase().includes('medication')) {
    // Use original item data for clipboard (keep all information)
    const parts: string[] = [];
    if (item.date) parts.push(item.date);
    if (item.name) parts.push(item.name);
    if (item.dosage) parts.push(item.dosage);
    if (item.frequency) parts.push(item.frequency);
    if (item.status) parts.push(item.status);
    description = parts.join(' ');
  } else {
    // For other categories, use formatItemDescription and strip HTML tags
    description = formatItemDescription(item, categoryName);
    description = description.replace(/<[^>]*>/g, '');
  }
  
  const excludeFile = item.fileName ? ` (excluding ${item.fileName})` : '';
  const query = `Find information about: ${description} in your knowledge base${excludeFile} and return the filename and page number in that file.`;
  
  try {
    await navigator.clipboard.writeText(query);
    $q.notify({
      message: 'Copied to clipboard!',
      type: 'positive',
      position: 'top',
      timeout: 2000
    });
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
    $q.notify({
      message: 'Failed to copy to clipboard',
      type: 'negative',
      position: 'top',
      timeout: 2000
    });
  }
};

const processInitialFile = async (overrideFile?: { bucketKey: string; fileName?: string }) => {
  logWizardEvent('lists_processing_start');
  wizardAutoStartPending.value = false;
  isProcessing.value = true;
  processingMessage.value = 'Parsing initial file...';
  error.value = '';
  pdfData.value = null;
  categories.value = [];
  markdownContent.value = '';

  try {
    const payload: { bucketKey?: string; fileName?: string } = {};
    if (overrideFile?.bucketKey) {
      payload.bucketKey = overrideFile.bucketKey;
      payload.fileName = overrideFile.fileName || 'Apple Health Export';
    } else if (initialFileInfo.value?.bucketKey) {
      payload.bucketKey = initialFileInfo.value.bucketKey;
      payload.fileName = initialFileInfo.value.fileName || 'Initial File';
    }

    const response = await fetch('/api/files/lists/process-initial-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}: ${response.statusText}` }));
      throw new Error(errorData.error || 'Failed to process initial file');
    }

    const data = await response.json();
    processingMessage.value = 'Extracting lists and categories...';
    
    pdfData.value = {
      totalPages: data.totalPages,
      pages: data.pages || [],
      categories: [],
      fullMarkdown: data.fullMarkdown || ''
    };
    
    const fullMarkdown = data.fullMarkdown || '';
    markdownBucketKey.value = data.markdownBucketKey || null;
    selectedFileName.value = data.fileName || 'Initial File';
    hasSavedResults.value = true;
    
    // Store initial file info if available (only for default flow)
    if (!overrideFile?.bucketKey && data.fileName) {
      // Get bucketKey from user-status if not in response
      if (!initialFileInfo.value) {
        const statusResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
          credentials: 'include'
        });
        if (statusResponse.ok) {
          const statusResult = await statusResponse.json();
          if (statusResult.initialFile && statusResult.initialFile.bucketKey) {
            initialFileInfo.value = {
              bucketKey: statusResult.initialFile.bucketKey,
              fileName: data.fileName
            };
          }
        }
      } else {
        initialFileInfo.value.fileName = data.fileName;
      }
    }
    
    // Load markdown and compute categories/observations on-the-fly
    const markedMarkdown = extractCategoriesFromMarkdown(fullMarkdown);
    markdownContent.value = markedMarkdown;
    countObservationsByPageRange(markdownContent.value);
    
    if (data.markdownBucketKey) {
      savedPdfBucketKey.value = data.markdownBucketKey;
    }
    
    if (data.pages && data.pages.length > 0) {
      activePageTab.value = data.pages[0].page;
    }
    logWizardEvent('lists_processing_complete', {
      hasMarkdown: !!data.fullMarkdown,
      pageCount: data.totalPages || 0
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to process initial file';
    error.value = errorMessage;
    console.error('Initial file processing error:', err);
    logWizardEvent('lists_processing_error', { error: errorMessage });
  } finally {
    isProcessing.value = false;
    processingMessage.value = '';
  }
};

const persistVerifyState = () => {
  if (!verifyStorageKey.value) return;
  sessionStorage.setItem(
    verifyStorageKey.value,
    JSON.stringify({
      needsVerifyAction: needsVerifyAction.value
    })
  );
};

const markVerifyRequired = () => {
  needsVerifyAction.value = true;
  showVerifyPrompt.value = true;
  persistVerifyState();
};

const clearVerifyRequirement = () => {
  needsVerifyAction.value = false;
  verifyPromptPending.value = false;
  persistVerifyState();
};

const handleVerifyCurrentMedications = async () => {
  if (!currentMedications.value) {
    clearVerifyRequirement();
    return;
  }
  await saveCurrentMedicationsValue(currentMedications.value, true, true);
};

/** User dismisses the verify prompt without verifying — don't show again until page reload. */
const handleVerifyDismissed = () => {
  medsDismissedThisSession.value = true;
  showVerifyPrompt.value = false;
  clearVerifyRequirement();
};

const logWizardEvent = async (event: string, details?: Record<string, unknown>) => {
  try {
    await fetch('/api/wizard-log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        event,
        userId: props.userId,
        details: details || {}
      })
    });
  } catch (error) {
    // Ignore logging errors
  }
};

const loadWizardAutoFlow = () => {
  try {
    wizardAutoFlow.value = sessionStorage.getItem(wizardAutoFlowStorageKey) === 'true';
  } catch (error) {
    wizardAutoFlow.value = false;
  }
  if (wizardAutoFlow.value) {
    logWizardEvent('lists_wizard_auto_flag', { value: wizardAutoFlow.value });
    wizardAutoStartPending.value = true;
  }
};

const clearWizardAutoFlow = () => {
  wizardAutoFlow.value = false;
  wizardAutoStartPending.value = false;
  isLoadingCurrentMedications.value = false;
  currentMedicationsStatus.value = '';
  try {
    sessionStorage.removeItem(wizardAutoFlowStorageKey);
  } catch (error) {
    // ignore
  }
};

const attemptAutoProcessInitialFile = async () => {
  if (isProcessing.value) return;
  if (hasSavedResults.value) return; // Already processed — don't redo
  if (currentMedications.value || isCurrentMedicationsEdited.value) return; // Medications already loaded
  const autoProcess = sessionStorage.getItem('autoProcessInitialFile');
  const shouldAutoProcess = autoProcess === 'true' || wizardAutoFlow.value;
  if (!shouldAutoProcess) return;

  logWizardEvent('lists_auto_start_attempt', {
    attempt: autoProcessAttempts.value + 1,
    hasSavedResults: hasSavedResults.value
  });

  await checkInitialFile();
  if (hasInitialFile.value) {
    if (autoProcess === 'true') {
      sessionStorage.removeItem('autoProcessInitialFile');
    }
    logWizardEvent('lists_auto_start_begin', { hasInitialFile: true });
    processInitialFile();
    return;
  }

  // Fallback: if no initialFile in user-status but appleHealthFileInfo was found
  // (e.g. new user from local folder — file is uploaded but not yet in user doc as initialFile)
  if (appleHealthFileInfo.value) {
    if (autoProcess === 'true') {
      sessionStorage.removeItem('autoProcessInitialFile');
    }
    logWizardEvent('lists_auto_start_begin', { hasInitialFile: false, appleHealthFallback: true });
    processInitialFile(appleHealthFileInfo.value);
    return;
  }

  if (autoProcessAttempts.value < 10) {
    autoProcessAttempts.value += 1;
    setTimeout(attemptAutoProcessInitialFile, 1000);
  } else {
    sessionStorage.removeItem('autoProcessInitialFile');
    logWizardEvent('lists_auto_start_failed', { hasInitialFile: false });
    // No Apple Health file — try to load/generate Current Medications (if not already loaded)
    if (!currentMedications.value && !isCurrentMedicationsEdited.value) {
      console.log('[Lists] No Apple Health file found after retries — falling back to loadCurrentMedications');
      loadCurrentMedications();
    }
  }
};

// processPdfFile and processPdfFromBucket removed - replaced with processInitialFile

// cleanupMarkdown function removed - not used

// Toggle markdown content visibility
const toggleMarkdownContent = () => {
  showMarkdownContent.value = !showMarkdownContent.value;
};

// Replace the Lists source file
const replaceListsSourceFile = () => {
  // Create a hidden file input
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf';
  input.style.display = 'none';
  
  input.onchange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    
    isReplacingFile.value = true;
    error.value = '';
    
    try {
      // Upload file to user root folder
      const formData = new FormData();
      formData.append('file', file);
      
      const uploadResponse = await fetch('/api/files/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      
      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json().catch(() => ({ error: `HTTP ${uploadResponse.status}` }));
        throw new Error(errorData.error || 'Failed to upload file');
      }
      
      const uploadResult = await uploadResponse.json();
      
      // Extract bucketKey from fileInfo
      const bucketKey = uploadResult.fileInfo?.bucketKey || uploadResult.bucketKey;
      if (!bucketKey) {
        throw new Error('Upload succeeded but no bucketKey returned');
      }
      
      // Process the uploaded file directly by passing bucketKey (no need to wait for document update)
      const processResponse = await fetch('/api/files/lists/process-initial-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          bucketKey: bucketKey,
          fileName: file.name
        })
      });
      
      if (!processResponse.ok) {
        const errorData = await processResponse.json().catch(() => ({ error: `HTTP ${processResponse.status}` }));
        throw new Error(errorData.error || 'Failed to process file');
      }
      
      const processResult = await processResponse.json();
      
      // Store initial file info FIRST (before async update)
      if (processResult.fileName) {
        initialFileInfo.value = {
          bucketKey: bucketKey,
          fileName: processResult.fileName
        };
      }
      
      // Update user document with new initial file (both initialFile and files array)
      // Await to ensure it completes before the user might reload the page
      try {
        await fetch('/api/user-file-metadata', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            fileMetadata: {
              fileName: file.name,
              bucketKey: uploadResult.bucketKey,
              fileSize: file.size,
              fileType: 'pdf'
            },
            updateInitialFile: true // Flag to also update initialFile field
          })
        });
      } catch (err) {
        // Failed to update user document (non-critical) - silently continue
      }
      
      // Update state
      pdfData.value = {
        totalPages: processResult.totalPages,
        pages: processResult.pages || [],
        categories: [],
        fullMarkdown: processResult.fullMarkdown || ''
      };
      
      const fullMarkdown = processResult.fullMarkdown || '';
      markdownBucketKey.value = processResult.markdownBucketKey || null;
      selectedFileName.value = processResult.fileName || file.name;
      hasSavedResults.value = true;
      
      // Load markdown and compute categories/observations on-the-fly
      const markedMarkdown = extractCategoriesFromMarkdown(fullMarkdown);
      markdownContent.value = markedMarkdown;
      countObservationsByPageRange(markdownContent.value);
      
      // Note: cleanupMarkdown() is not needed here because the markdown is already cleaned
      // during processing. cleanupMarkdown() would reload from the endpoint and might
      // overwrite our freshly processed markdown with an older version.
      
      // Automatically show markdown content
      showMarkdownContent.value = true;
      
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          message: 'Lists source file replaced and processed successfully',
          type: 'positive',
          position: 'top',
          timeout: 3000
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to replace file';
      error.value = errorMessage;
      console.error('Replace file error:', err);
      
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          message: errorMessage,
          type: 'negative',
          position: 'top',
          timeout: 5000
        });
      }
    } finally {
      isReplacingFile.value = false;
      document.body.removeChild(input);
    }
  };
  
  document.body.appendChild(input);
  input.click();
};

// Extract unique categories from markdown (lines starting with "### ")
// Labels ALL [D+P] lines with category name and tracks category boundaries
const extractCategoriesFromMarkdown = (markdown: string) => {
  if (!markdown) {
    categoriesList.value = [];
    return markdown;
  }
  
  const lines = markdown.split('\n');
  const categoryMap = new Map<string, { name: string; page: number; observationCount: number; startLine: number; endLine: number }>();
  const dateLocationPattern = /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\S+/i;
  
  // Build page boundary map: page number -> line index
  const pageBoundaries = new Map<number, number>();
  
  // Track category boundaries: category name -> { startLine, endLine }
  // For categories that appear multiple times, track the first start and last end
  const categoryBoundaries = new Map<string, { startLine: number; endLine: number }>();
  
  // Track which categories have had their first [D+P] line labeled
  const categoryFirstDPlusLabeled = new Map<string, boolean>();
  
  // FIRST PASS: Find ALL categories, label first [D+P] line in each category, and track category boundaries
  let currentPage = 0;
  let currentCategory: string | null = null;
  let currentCategoryStartLine = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const originalLine = lines[i];
    
    // Check for page header: "## Page nn"
    const pageMatch = line.match(/^##\s+Page\s+(\d+)$/);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
      pageBoundaries.set(currentPage, i);
      continue;
    }
    
    // Check for category header: "### Category Name"
    if (line.startsWith('### ')) {
      // Close previous category if exists
      if (currentCategory && currentCategoryStartLine >= 0) {
        const existing = categoryBoundaries.get(currentCategory);
        if (existing) {
          // Update end line if this is later
          existing.endLine = i - 1;
        } else {
          // First occurrence of this category
          categoryBoundaries.set(currentCategory, {
            startLine: currentCategoryStartLine,
            endLine: i - 1
          });
        }
      }
      
      const categoryName = line.substring(4).trim();
      currentCategory = categoryName;
      currentCategoryStartLine = i;
      
      // Add ALL categories to the map (only once per unique category name)
      if (categoryName && !categoryMap.has(categoryName)) {
        categoryMap.set(categoryName, {
          name: categoryName,
          page: currentPage || 1,
          observationCount: 0,
          startLine: i,
          endLine: lines.length - 1 // Will be updated when category ends
        });
        // Initialize boundary tracking
        categoryBoundaries.set(categoryName, {
          startLine: i,
          endLine: lines.length - 1
        });
        // Initialize first [D+P] labeled flag (only once per unique category)
        categoryFirstDPlusLabeled.set(categoryName, false);
      } else if (categoryName && categoryMap.has(categoryName)) {
        // Category already exists - update start line if this is earlier
        const existing = categoryBoundaries.get(categoryName);
        if (existing && i < existing.startLine) {
          existing.startLine = i;
        }
        // Don't reset flag - we only want to label the FIRST [D+P] line once per category
      }
      continue;
    }
    
    // Label ONLY the first [D+P] line in each unique category with category name
    // Label all other [D+P] lines with just [D+P] prefix
    if (currentCategory) {
      // Check if this line matches Date + Place pattern (and not already marked)
      if (!line.startsWith('[D+P] ') && dateLocationPattern.test(line)) {
        const isFirstDPlus = !categoryFirstDPlusLabeled.get(currentCategory);
        if (isFirstDPlus) {
          // Label ONLY the first [D+P] line with category name (once per unique category)
          lines[i] = `[D+P] ${currentCategory} ${originalLine}`;
          categoryFirstDPlusLabeled.set(currentCategory, true);
        } else {
          // Label all other [D+P] lines with just [D+P] prefix
          lines[i] = `[D+P] ${originalLine}`;
        }
      }
    }
  }
  
  // Close last category if exists
  if (currentCategory && currentCategoryStartLine >= 0) {
    const existing = categoryBoundaries.get(currentCategory);
    if (existing) {
      existing.endLine = lines.length - 1;
    } else {
      categoryBoundaries.set(currentCategory, {
        startLine: currentCategoryStartLine,
        endLine: lines.length - 1
      });
    }
  }
  
  // Update categoryMap with boundaries
  for (const [categoryName, boundaries] of categoryBoundaries.entries()) {
    if (categoryMap.has(categoryName)) {
      const category = categoryMap.get(categoryName)!;
      category.startLine = boundaries.startLine;
      category.endLine = boundaries.endLine;
    }
  }
  
  // Convert map to array
  categoriesList.value = Array.from(categoryMap.values());
  
  // Return modified markdown with ALL [D+P] lines labeled
  return lines.join('\n');
};

// Handle category page link click
const handleCategoryPageClick = async (page: number) => {
  // Ensure initialFileInfo is loaded
  if (!initialFileInfo.value) {
    await checkInitialFile();
  }
  
  if (!initialFileInfo.value) {
    console.warn('No initial file info available for PDF viewing');
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'PDF file information not available. Please try refreshing the page.',
        timeout: 3000
      });
    }
    return;
  }
  
  const fileName = initialFileInfo.value.fileName;
  const filePayload = {
    bucketKey: initialFileInfo.value.bucketKey,
    name: fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`
  };
  viewingPdfFile.value = filePayload;
  pdfInitialPage.value = page;
  showPdfViewer.value = true;
};

// Handle observation click (for Clinical Vitals line count links)
const handleObservationClick = async (event: Event, page?: number) => {
  const target = event.target as HTMLElement;
  // Check if clicked element is a link with data-page attribute
  if (target.tagName === 'A' && target.getAttribute('data-page') && page) {
    event.preventDefault();
    await handleCategoryPageClick(page);
  }
};

const downloadMarkdown = () => {
  const contentToDownload = markdownContent.value || (pdfData.value?.fullMarkdown);
  if (!contentToDownload) {
    error.value = 'No markdown content available to download';
    return;
  }

  try {
    // Create a blob with the markdown content
    const blob = new Blob([contentToDownload], { type: 'text/markdown' });
    
    // Create a download link
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    // Generate filename from original file name or use default
    const baseName = selectedFileName.value 
      ? selectedFileName.value.replace(/\.pdf$/i, '')
      : 'extracted-pdf';
    link.download = `${baseName}.md`;
    
    // Trigger download
    document.body.appendChild(link);
    link.click();
    
    // Cleanup
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to download markdown file';
    console.error('Download error:', err);
  }
};

const formatNoteDescription = (note: ClinicalNote): string => {
  const parts: string[] = [];
  
  if (note.type) {
    parts.push(`Type: ${note.type}`);
  }
  if (note.author) {
    parts.push(`Author: ${note.author}`);
  }
  if (note.category) {
    parts.push(`Category: ${note.category}`);
  }
  if (note.created) {
    parts.push(`Created: ${note.created}`);
  }
  
  return parts.join('; ') || 'No details available';
};

const copyNoteToClipboard = async (note: ClinicalNote) => {
  const description = formatNoteDescription(note);
  // Exclude the source document from the search - we want RAG to find it in other documents
  const excludeFile = note.fileName ? ` (excluding ${note.fileName})` : '';
  const query = `Find the encounter note for: ${description} in your knowledge base${excludeFile} and return the filename and page number in that file.`;
  
  try {
    await navigator.clipboard.writeText(query);
    $q.notify({
      message: 'Copied to clipboard!',
      type: 'positive',
      position: 'top',
      timeout: 2000
    });
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
    // Fallback: try using a temporary textarea
    const textarea = document.createElement('textarea');
    textarea.value = query;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      $q.notify({
        message: 'Copied to clipboard!',
        type: 'positive',
        position: 'top',
        timeout: 2000
      });
    } catch (fallbackErr) {
      console.error('Fallback copy failed:', fallbackErr);
      $q.notify({
        message: 'Failed to copy to clipboard',
        type: 'negative',
        position: 'top',
        timeout: 2000
      });
    }
    document.body.removeChild(textarea);
  }
};

// Find page number for a given line index
const findPageForLine = (lineIndex: number, lines: string[]): number => {
  let currentPage = 1;
  for (let i = 0; i <= lineIndex && i < lines.length; i++) {
    const line = lines[i].trim();
    const pageMatch = line.match(/^##\s+Page\s+(\d+)$/);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
    }
  }
  return currentPage;
};

// Fix "OUT OF RANGE" text that may have encoding issues with the E in RANGE
const fixOutOfRangeText = (text: string): string => {
  // Replace variations of "RANG" followed by any character with "RANGE"
  // This handles cases where "RANGE" is displayed as "RANG*" or "RANG?" etc.
  return text.replace(/RANG[^\s]/gi, 'RANGE');
};

// Extract observations for a category based on its type
const extractObservationsForCategory = (
  categoryName: string,
  startLine: number,
  endLine: number,
  lines: string[]
): Array<{ date: string; display: string; page?: number; lineCount?: number; outOfRangeLines?: string[] }> => {
  const observations: Array<{ date: string; display: string; page?: number; lineCount?: number; outOfRangeLines?: string[] }> = [];
  const categoryLower = categoryName.toLowerCase();
  
  // For Clinical Vitals and Lab Results, track observations by date to merge duplicates
  const shouldMergeByDate = categoryLower.includes('clinical vitals') || categoryLower.includes('lab result');
  const mergedByDate = new Map<string, { lineCount: number; page?: number; outOfRangeLines?: string[] }>();
  
  // Special handling for Immunizations: each content line after [D+P] becomes a separate observation
  const isImmunizations = categoryLower.includes('immunization');
  
  let currentObservationStart = -1;
  let currentDate = '';
  let dPlusCount = 0;
  
  for (let i = startLine; i <= endLine && i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check if this is a [D+P] line (start of new observation)
    if (line.startsWith('[D+P] ')) {
      dPlusCount++;
      
      // For Immunizations: process all content lines from previous [D+P] as separate observations
      if (isImmunizations && currentObservationStart >= 0 && currentDate) {
        const page = findPageForLine(currentObservationStart, lines);
        const dPlusLine = lines[currentObservationStart]; // The [D+P] line
        
        // For Immunizations, create one observation per content line (skip the [D+P] line itself)
        // Content lines are non-empty lines that don't start with [D+P], ###, or ##
        for (let j = currentObservationStart + 1; j < i; j++) {
          const contentLine = lines[j].trim();
          // Skip empty lines, category headers, page headers, and [D+P] lines
          if (contentLine && 
              !contentLine.startsWith('[D+P]') && 
              !contentLine.startsWith('###') && 
              !contentLine.startsWith('## ')) {
            // Create a separate observation for this content line
            // formatObservation expects obsLines[0] to be the [D+P] line and obsLines[1] to be the content
            const singleLineObs = [dPlusLine, lines[j]]; // [D+P] line + content line
            const display = formatObservation(categoryName, currentDate, singleLineObs, page);
            if (display) {
              observations.push({ 
                date: currentDate, 
                display, 
                page, 
                lineCount: 1
              });
            }
          }
        }
      } else if (currentObservationStart >= 0 && currentDate) {
        // For other categories, process as before
        const obsLines = lines.slice(currentObservationStart, i);
        const page = findPageForLine(currentObservationStart, lines);
        
        // For Lab Results, track lines with "OUT   OF   RANG*"
        let outOfRangeLines: string[] = [];
        if (categoryLower.includes('lab result')) {
          outOfRangeLines = obsLines.filter(l => l.includes('OUT') && l.includes('OF') && l.includes('RANG'));
        }
        
        if (shouldMergeByDate) {
          // For Clinical Vitals and Lab Results, merge observations with same date
          const existing = mergedByDate.get(currentDate);
          if (existing) {
            existing.lineCount += obsLines.length;
            // Merge out of range lines
            if (categoryLower.includes('lab result') && outOfRangeLines.length > 0) {
              if (!existing.outOfRangeLines) {
                existing.outOfRangeLines = [];
              }
              existing.outOfRangeLines.push(...outOfRangeLines);
            }
            // Keep the first page encountered for this date
          } else {
            mergedByDate.set(currentDate, { 
              lineCount: obsLines.length, 
              page,
              outOfRangeLines: categoryLower.includes('lab result') ? outOfRangeLines : undefined
            });
          }
        } else {
          // For other categories, create separate observations
          const display = formatObservation(categoryName, currentDate, obsLines, page);
          if (display) {
            observations.push({ 
              date: currentDate, 
              display, 
              page, 
              lineCount: obsLines.length,
              outOfRangeLines: categoryLower.includes('lab result') && outOfRangeLines.length > 0 ? outOfRangeLines : undefined
            });
          }
        }
      }
      
      // Extract date from [D+P] line
      const dateMatch = line.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
      if (dateMatch) {
        currentDate = dateMatch[1];
        currentObservationStart = i;
      }
    }
  }
  
  // Save last observation
  if (currentObservationStart >= 0 && currentDate) {
    const obsLines = lines.slice(currentObservationStart, endLine + 1);
    const page = findPageForLine(currentObservationStart, lines);
    
    // For Immunizations: process all content lines as separate observations
    if (isImmunizations) {
      const dPlusLine = lines[currentObservationStart]; // The [D+P] line
      
      // Create one observation per content line (skip the [D+P] line itself)
      for (let j = currentObservationStart + 1; j <= endLine; j++) {
        const contentLine = lines[j].trim();
        // Skip empty lines, category headers, page headers, and [D+P] lines
        if (contentLine && 
            !contentLine.startsWith('[D+P]') && 
            !contentLine.startsWith('###') && 
            !contentLine.startsWith('## ')) {
          // Create a separate observation for this content line
          // formatObservation expects obsLines[0] to be the [D+P] line and obsLines[1] to be the content
          const singleLineObs = [dPlusLine, lines[j]]; // [D+P] line + content line
          const display = formatObservation(categoryName, currentDate, singleLineObs, page);
          if (display) {
            observations.push({ 
              date: currentDate, 
              display, 
              page, 
              lineCount: 1
            });
          }
        }
      }
    } else {
      // For other categories, process as before
      // For Lab Results, track lines with "OUT   OF   RANG*"
      let outOfRangeLines: string[] = [];
      if (categoryLower.includes('lab result')) {
        outOfRangeLines = obsLines.filter(l => l.includes('OUT') && l.includes('OF') && l.includes('RANG'));
      }
      
      if (shouldMergeByDate) {
        // For Clinical Vitals and Lab Results, merge observations with same date
        const existing = mergedByDate.get(currentDate);
        if (existing) {
          existing.lineCount += obsLines.length;
          // Merge out of range lines
          if (categoryLower.includes('lab result') && outOfRangeLines.length > 0) {
            if (!existing.outOfRangeLines) {
              existing.outOfRangeLines = [];
            }
            existing.outOfRangeLines.push(...outOfRangeLines);
          }
        } else {
          mergedByDate.set(currentDate, { 
            lineCount: obsLines.length, 
            page,
            outOfRangeLines: categoryLower.includes('lab result') && outOfRangeLines.length > 0 ? outOfRangeLines : undefined
          });
        }
      } else {
        // For other categories, create separate observations
        const display = formatObservation(categoryName, currentDate, obsLines, page);
        if (display) {
          observations.push({ 
            date: currentDate, 
            display, 
            page, 
            lineCount: obsLines.length,
            outOfRangeLines: categoryLower.includes('lab result') && outOfRangeLines.length > 0 ? outOfRangeLines : undefined
          });
        }
      }
    }
  }
  
  // For Clinical Vitals and Lab Results, convert merged dates to observations
  if (shouldMergeByDate) {
    for (const [date, data] of mergedByDate.entries()) {
      const display = formatObservation(categoryName, date, [], data.page, data.lineCount);
      if (display) {
        observations.push({ 
          date, 
          display, 
          page: data.page, 
          lineCount: data.lineCount,
          outOfRangeLines: data.outOfRangeLines
        });
      }
    }
  }
  
  // Special handling for Allergies: if no [D+P] lines found, treat entire category as one observation
  if (categoryLower.includes('allerg') && dPlusCount === 0 && endLine > startLine) {
    const allLines = lines.slice(startLine, endLine + 1);
    const page = findPageForLine(startLine, lines);
    // For Allergies, don't use a date - just use empty string
    const allergyDate = '';
    const display = formatObservation(categoryName, allergyDate, allLines, page);
    if (display && allLines.length > 1) {
      observations.push({ date: allergyDate, display, page });
    }
  }
  
  return observations;
};

// Format observation display based on category type
const formatObservation = (
  categoryName: string,
  date: string,
  obsLines: string[],
  page?: number,
  lineCount?: number
): string => {
  const categoryLower = categoryName.toLowerCase();
  
  if (categoryLower.includes('allerg')) {
    // Allergies: Display only lines that look like allergy entries (e.g., "SULFA ...")
    // Filter out category headers (###), page headers (##), and other non-allergy lines
    if (obsLines.length >= 1) {
      // Filter to only include lines that look like allergy entries
      // These typically start with uppercase letters and contain allergy information
      const allergyLines = obsLines.filter(line => {
        const trimmed = line.trim();
        // Skip empty lines, category headers, and page headers
        if (!trimmed || trimmed.startsWith('###') || trimmed.startsWith('## ')) {
          return false;
        }
        // Include lines that start with uppercase letters (like "SULFA")
        // and don't look like metadata or headers
        const firstChar = trimmed.charAt(0);
        return firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase();
      });
      
      if (allergyLines.length > 0) {
        const formattedLines = allergyLines.map(line => {
          const trimmed = line.trim();
          // Get first word and rest of line
          const firstSpaceIndex = trimmed.indexOf(' ');
          if (firstSpaceIndex > 0) {
            const firstWord = trimmed.substring(0, firstSpaceIndex);
            const rest = trimmed.substring(firstSpaceIndex + 1);
            return `**${firstWord}** ${rest}`;
          }
          // If no space, just bold the whole line
          return `**${trimmed}**`;
        });
        
        if (formattedLines.length > 0) {
          // If date is empty, don't include it in the display
          return date ? `${date} ${formattedLines.join(' ')}` : formattedLines.join(' ');
        }
      }
    }
    return date;
  } else if (categoryLower.includes('medication')) {
    // Medications: Date + medication name + dose (both in bold)
    if (obsLines.length > 1) {
      const nextLine = obsLines[1]?.trim() || '';
      const parts = nextLine.split(/\s+/);
      if (parts.length >= 2) {
        const medicationName = parts[0];
        const dose = parts.slice(1).join(' ');
        return `${date} **${medicationName}** **${dose}**`;
      }
      return `${date} **${nextLine}**`;
    }
    return date;
  } else if (categoryLower.includes('clinical notes')) {
    // Clinical Notes: Date + observation name (Line 1 of 5) + Author (Line 2 of 5) both in bold
    // Structure: [D+P] line (index 0), Line 1 = Type, Line 2 = Author, Line 3 = Category, Line 4 = Created, Line 5 = Status
    if (obsLines.length >= 3) {
      // Line 1 of 5 is at index 1 (after [D+P] line at index 0)
      const typeLine = obsLines[1]?.trim() || '';
      // Line 2 of 5 is at index 2
      const authorLine = obsLines[2]?.trim() || '';
      
      // Clean up the lines - remove any "Type:" or "Author:" prefixes if present
      let type = typeLine.replace(/^Type:\s*/i, '').trim();
      let author = authorLine.replace(/^Author:\s*/i, '').trim();
      
      // If still empty, use the raw line
      if (!type) type = typeLine;
      if (!author) author = authorLine;
      
      return `${date} **${type || 'N/A'}** by **${author || 'N/A'}**`;
    } else if (obsLines.length >= 2) {
      // Fallback if structure is different - at least try to get first line
      const typeLine = obsLines[1]?.trim() || '';
      return `${date} **${typeLine || 'N/A'}** by **N/A**`;
    }
    return date;
  } else if (categoryLower.includes('procedure') || 
             categoryLower.includes('condition') || 
             categoryLower.includes('immunization')) {
    // Procedures, Conditions, Immunizations: Date + entire line following [D+P] (in bold)
    if (obsLines.length > 1) {
      let nextLine = obsLines[1]?.trim() || '';
      // For Procedures, remove "## " from the start if present
      if (categoryLower.includes('procedure') && nextLine.startsWith('## ')) {
        nextLine = nextLine.substring(3).trim();
      }
      return `${date} **${nextLine}**`;
    }
    return date;
  } else if (categoryLower.includes('clinical vitals') || 
             categoryLower.includes('lab result')) {
    // Clinical Vitals, Lab Results: Date + total number of lines in observation (clickable if page available)
    // Use provided lineCount if available (for merged Clinical Vitals), otherwise use obsLines.length
    const count = lineCount ?? obsLines.length;
    if (page && (categoryLower.includes('clinical vitals') || categoryLower.includes('lab result'))) {
      // Make line count clickable for Clinical Vitals and Lab Results
      return `${date} (<a href="#" class="text-primary" style="text-decoration: underline; cursor: pointer;" data-page="${page}">${count} line${count !== 1 ? 's' : ''}</a>)`;
    }
    return `${date} (${count} line${count !== 1 ? 's' : ''})`;
  }
  
  // Default: just show date
  return date;
};

// SECOND PASS: Count [D+P] lines for each category using category boundaries from FIRST PASS
const countObservationsByPageRange = (markedMarkdown: string): void => {
  if (!markedMarkdown) {
    return;
  }
  
  const lines = markedMarkdown.split('\n');
  
  // Ensure categoriesList is initialized
  if (!categoriesList.value || categoriesList.value.length === 0) {
    return;
  }
  
  // Process each category using boundaries calculated in FIRST PASS
  categoriesList.value = categoriesList.value.map(category => {
    const categoryName = category.name;
    const startLine = category.startLine ?? 0;
    const endLine = category.endLine ?? lines.length - 1;
    
    // Count [D+P] lines in this category's range
    let dPlusCount = 0;
    
    // Scan only the lines for this category
    for (let i = startLine; i <= endLine && i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Check if this is a [D+P] line
      // First [D+P] line will have category name: "[D+P] <category name> <date and place>"
      // Other [D+P] lines will just have: "[D+P] <date and place>"
      if (line.startsWith(`[D+P] ${categoryName} `)) {
        // This is the first [D+P] line with category label
        dPlusCount++;
      } else if (line.startsWith('[D+P] ') && !line.startsWith(`[D+P] ${categoryName} `)) {
        // Check if this is a [D+P] line without category label (subsequent ones)
        // Pattern: "[D+P] <date and place>" - date pattern after [D+P]
        const datePattern = /^\[D\+P\]\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\S+)/;
        if (datePattern.test(line)) {
          // This is a [D+P] line without category label (subsequent ones in this category)
          dPlusCount++;
          
          // Count this [D+P] line
        }
      }
    }
    
    // Extract observations for this category
    const observations = extractObservationsForCategory(categoryName, startLine, endLine, lines);
    
    return {
      ...category,
      observationCount: dPlusCount,
      observations: observations,
      expanded: expandedCategories.value.has(categoryName)
    };
  });
  
  // After processing categories: if Medication Records exist, load current medications from file; otherwise open block for editing with user-reported title
  // Guard: skip if medications are already loaded/edited, currently being loaded, already present, or mount still initializing
  if (!isCurrentMedicationsEdited.value && !currentMedications.value && !loadCurrentMedicationsRunning && !mountInitializing) {
    const medicationCategory = categoriesList.value.find(cat =>
      cat.name.toLowerCase().includes('medication')
    );
    if (medicationCategory && medicationCategory.observations && medicationCategory.observations.length > 0) {
      // Cancel any premature edit mode from before categories were ready
      if (isEditingCurrentMedications.value && !editingCurrentMedications.value) {
        isEditingCurrentMedications.value = false;
        currentMedicationsBlockTitle.value = 'Current Medications';
      }
      loadCurrentMedications();
    } else {
      isLoadingCurrentMedications.value = false;
      isInitialMedsLoading.value = false;
      currentMedicationsStatus.value = '';
      currentMedicationsBlockTitle.value = 'Current Medications as reported by the user';
      startEditingCurrentMedications();
    }
  }

  // Category files are built once during Apple Health processing (server-side)
};


// Load categories and observations from stored category files (deprecated - using on-the-fly computation)
/*
const loadCategoriesFromFiles = async () => {
  try {
    // Get list of category files
    const categoriesResponse = await fetch('/api/files/lists/categories', {
      credentials: 'include'
    });
    
    if (!categoriesResponse.ok) {
      return;
    }
    
    const categoriesResult = await categoriesResponse.json();
    
    if (!categoriesResult.success || !categoriesResult.categories || categoriesResult.categories.length === 0) {
      categoriesList.value = [];
      return;
    }
    
    // Load each category file and parse observations
    const loadedCategories = [];
    
    for (const categoryFile of categoriesResult.categories) {
      try {
        const categoryName = categoryFile.category;
        const fileName = categoryFile.fileName; // Use the actual filename from the list
        
        // Use the filename directly (without .md extension) as the parameter
        const categoryNameParam = fileName.replace(/\.md$/, '');
        const categoryUrl = `/api/files/lists/category/${encodeURIComponent(categoryNameParam)}`;
        
        const categoryResponse = await fetch(categoryUrl, {
          credentials: 'include'
        });
        
        if (categoryResponse.ok) {
          const categoryResult = await categoryResponse.json();
          const content = categoryResult.content;
          
          // Parse category file to extract observations
          const observations = parseObservationsFromCategoryFile(content, categoryName);
          
          // Extract page number from first observation or use default
          const firstPage = observations.length > 0 && observations[0].page 
            ? observations[0].page 
            : 1;
          
          loadedCategories.push({
            name: categoryName,
            page: firstPage,
            observationCount: observations.length,
            observations: observations,
            expanded: expandedCategories.value.has(categoryName)
          });
        }
      } catch (err) {
        // Error loading category file - silently continue
      }
    }
    
    categoriesList.value = loadedCategories;
  } catch (err) {
    categoriesList.value = [];
  }
};
*/

// Parse observations from a category markdown file (deprecated - only used in commented-out code)
// @ts-ignore - Function is only used in commented-out code
const parseObservationsFromCategoryFile = (content: string, _categoryName: string): Array<{ date: string; display: string; page?: number; lineCount?: number; outOfRangeLines?: string[] }> => {
  const observations = [];
  const lines = content.split('\n');
  
  let currentObservation: { date?: string; page?: number; display?: string; outOfRangeLines?: string[] } | null = null;
  let observationLines: string[] = [];
  let state: 'header' | 'metadata' | 'display' | 'outofrange' = 'header';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Skip header and total observations line
    if (trimmed.startsWith('#') || trimmed.startsWith('**Total Observations:**')) {
      continue;
    }
    
    // Check for observation separator
    if (trimmed === '---') {
      // Save previous observation if exists
      if (currentObservation) {
        if (observationLines.length > 0) {
          currentObservation.display = observationLines.join(' ').trim();
        }
        if (currentObservation.display) {
          observations.push({
            date: currentObservation.date || '',
            display: currentObservation.display,
            page: currentObservation.page,
            outOfRangeLines: currentObservation.outOfRangeLines
          });
        }
      }
      // Start new observation
      currentObservation = {};
      observationLines = [];
      state = 'metadata';
      continue;
    }
    
    // Check for date
    if (trimmed.startsWith('**Date:**')) {
      const dateMatch = trimmed.match(/\*\*Date:\*\*\s*(.+)/);
      if (dateMatch) {
        currentObservation = currentObservation || {};
        currentObservation.date = dateMatch[1].trim();
        state = 'metadata';
      }
      continue;
    }
    
    // Check for page
    if (trimmed.startsWith('**Page:**')) {
      const pageMatch = trimmed.match(/\*\*Page:\*\*\s*(\d+)/);
      if (pageMatch) {
        currentObservation = currentObservation || {};
        currentObservation.page = parseInt(pageMatch[1], 10);
        state = 'display'; // After page, next non-empty line is display content
      }
      continue;
    }
    
    // Check for out of range section
    if (trimmed.startsWith('**Out of Range:**')) {
      currentObservation = currentObservation || {};
      currentObservation.outOfRangeLines = [];
      state = 'outofrange';
      // Collect out of range lines (lines starting with "-")
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j].trim();
        if (nextLine.startsWith('-')) {
          currentObservation.outOfRangeLines.push(nextLine.substring(1).trim());
          j++;
        } else if (nextLine === '' || nextLine === '---') {
          break;
        } else {
          j++;
        }
      }
      i = j - 1; // Skip processed lines
      continue;
    }
    
    // Collect display content
    // Display content comes after Date/Page metadata (possibly after a blank line)
    // Note: Display content can start with ** (markdown bold), so we check for metadata patterns instead
    if (currentObservation) {
      if (state === 'metadata' && trimmed === '') {
        // Blank line after Date/Page metadata - switch to display mode
        state = 'display';
      } else if (state === 'display' && trimmed && !trimmed.startsWith('**Date:**') && !trimmed.startsWith('**Page:**') && !trimmed.startsWith('**Out of Range:**') && !trimmed.startsWith('- ') && trimmed !== '---') {
        // We're in display mode - collect the content (can start with ** for markdown bold)
        observationLines.push(trimmed);
      } else if (state === 'metadata' && trimmed && !trimmed.startsWith('**Date:**') && !trimmed.startsWith('**Page:**') && !trimmed.startsWith('**Out of Range:**') && !trimmed.startsWith('- ') && trimmed !== '---') {
        // Display content came immediately after Page (no blank line) - switch to display and collect
        state = 'display';
        observationLines.push(trimmed);
      }
    }
  }
  
  // Add last observation if exists
  if (currentObservation) {
    if (observationLines.length > 0) {
      currentObservation.display = observationLines.join(' ').trim();
    }
    if (currentObservation.display) {
      observations.push({
        date: currentObservation.date || '',
        display: currentObservation.display,
        page: currentObservation.page,
        outOfRangeLines: currentObservation.outOfRangeLines
      });
    }
  }
  
  return observations;
};

// Reload categories and observations from markdown
const reloadCategories = async () => {
  if (markdownContent.value) {
    const markedMarkdown = extractCategoriesFromMarkdown(markdownContent.value);
    countObservationsByPageRange(markedMarkdown);
  }
};

onMounted(async () => {
  loadWizardAutoFlow();

  // Always try to load saved medications from the user document first.
  // This returns instantly if medications are saved, avoiding the 10-second
  // retry chain in attemptAutoProcessInitialFile.
  await loadCurrentMedications();
  isInitialMedsLoading.value = false;

  await checkInitialFile();
  await loadSavedResults();

  // Only start auto-processing if no medications were loaded AND no saved results
  if (!hasSavedResults.value && !currentMedications.value) {
    await nextTick();
    attemptAutoProcessInitialFile();
  }

  // Mount complete — allow onActivated/watchers to proceed
  mountInitializing = false;

  // Check if we should auto-edit medications (from deep link)
  const autoEdit = sessionStorage.getItem('autoEditMedications');
  if (autoEdit === 'true' && currentMedications.value) {
    // Clear the flag
    sessionStorage.removeItem('autoEditMedications');
    // Wait a bit for the dialog to fully open, then start editing
    await nextTick();
    setTimeout(() => {
      startEditingCurrentMedications();
    }, 500);
  }

  if (verifyStorageKey.value) {
    const storedVerify = sessionStorage.getItem(verifyStorageKey.value);
    if (storedVerify) {
      try {
        const parsed = JSON.parse(storedVerify);
        needsVerifyAction.value = !!parsed.needsVerifyAction;
      } catch (error) {
        // Ignore malformed storage
      }
    }
  }
});

watch([currentMedications, hasSavedResults, isProcessing], ([meds, saved, processing], [prevMeds]) => {
  if (processing) return;
  if (!saved || !meds || isCurrentMedicationsEdited.value || needsVerifyAction.value || medsDismissedThisSession.value) {
    return;
  }
  if (!prevMeds) {
    markVerifyRequired();
  }
  if (meds && wizardAutoFlow.value) {
    clearWizardAutoFlow();
  }
});

onActivated(() => {
  loadWizardAutoFlow();
  if (verifyPromptPending.value && needsVerifyAction.value && !medsDismissedThisSession.value) {
    showVerifyPrompt.value = true;
    verifyPromptPending.value = false;
  }
});

onDeactivated(() => {
  if (needsVerifyAction.value && !isEditingCurrentMedications.value && !medsDismissedThisSession.value) {
    showVerifyPrompt.value = true;
    verifyPromptPending.value = true;
  }
});

/**
 * Extract the "Current Medications" section from a Patient Summary text.
 * Mirrors the logic in MyStuffDialog.vue's extractMedicationsFromSummary.
 */
const extractMedicationsFromSummary = (summaryText: string): string | null => {
  const lines = summaryText.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();
    if (
      line.match(/^#{1,3}\s*current\s+medications/) ||
      line.match(/^\*{1,2}current\s+medications\*{1,2}/) ||
      line === 'current medications' ||
      line === 'current medications:'
    ) {
      startIdx = i + 1;
      break;
    }
  }
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.match(/^#{1,3}\s+/) || (line.match(/^\*{2}.+\*{2}$/) && !line.toLowerCase().includes('medication'))) {
      endIdx = i;
      break;
    }
  }
  const medsText = lines.slice(startIdx, endIdx).join('\n').trim();
  return medsText.length > 0 ? medsText : null;
};

// Mutex to prevent concurrent calls to loadCurrentMedications
let loadCurrentMedicationsRunning = false;
// Guard: onMounted is still initializing — suppress duplicate loads from onActivated/watchers
let mountInitializing = true;

// Load current medications from user document, Patient Summary, or Medication Records
const loadCurrentMedications = async (forceRefresh = false) => {
  // Guard: already edited — never recalculate
  if (isCurrentMedicationsEdited.value && !forceRefresh) {
    console.log('[Lists] Current Medications already verified/edited — skipping');
    isInitialMedsLoading.value = false;
    return;
  }

  // Mutex: prevent duplicate concurrent calls
  if (loadCurrentMedicationsRunning) {
    console.log('[Lists] loadCurrentMedications already running — skipping duplicate call');
    return;
  }
  loadCurrentMedicationsRunning = true;

  console.log('[Lists] Loading Current Medications (forceRefresh=%s)', forceRefresh);
  logWizardEvent('current_meds_load_start', { forceRefresh });

  try {
    // Path 1: Check user document for previously saved medications
    if (!forceRefresh) {
      try {
        const statusResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.userId)}`, {
          credentials: 'include'
        });
        if (statusResponse.ok) {
          const statusResult = await statusResponse.json();
          if (statusResult.currentMedications) {
            currentMedications.value = statusResult.currentMedications;
            isCurrentMedicationsEdited.value = true;
            isInitialMedsLoading.value = false;
            console.log('[Lists] Current Medications loaded from saved user document (%d chars)', statusResult.currentMedications.length);
            logWizardEvent('current_meds_loaded_from_user_doc', { length: statusResult.currentMedications.length });
            return;
          }
        }
      } catch (err) {
        console.warn('[Lists] Error checking user document for medications:', err);
      }
    }

    // Path 2: Check for Medication Records from Apple Health categories
    const medicationCategory = categoriesList.value.find(cat =>
      cat.name.toLowerCase().includes('medication')
    );

    if (medicationCategory && medicationCategory.observations && medicationCategory.observations.length > 0) {
      // Apple Health has medication records — use AI to extract current medications
      console.log('[Lists] Medication Records found in Apple Health categories — extracting with AI');
      isInitialMedsLoading.value = false;
      currentMedicationsStatus.value = 'waiting';
      const agentReady = await waitForAgentReady();
      if (!agentReady) {
        currentMedications.value = null;
        logWizardEvent('current_meds_agent_not_ready');
        currentMedicationsStatus.value = '';
        return;
      }
      isLoadingCurrentMedications.value = true;
      currentMedicationsStatus.value = 'reviewing';
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        currentMedicationsStatus.value = 'consulting';
        const response = await fetch('/api/files/lists/current-medications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ medicationRecords: medicationCategory.observations })
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          throw new Error(errorData.error || 'Failed to get current medications');
        }
        const result = await response.json();
        if (result.success && result.currentMedications) {
          const cleaned = removeHeadingsFromResponse(result.currentMedications);
          currentMedications.value = cleaned;
          isCurrentMedicationsEdited.value = false;
          isEditingCurrentMedications.value = false;
          currentMedicationsBlockTitle.value = 'Current Medications';
          console.log('[Lists] Current Medications generated from Apple Health records (%d chars)', cleaned.length);
          logWizardEvent('current_meds_generated', { length: cleaned.length });
        } else {
          currentMedications.value = null;
          logWizardEvent('current_meds_empty_response');
        }
      } catch (err) {
        console.error('[Lists] Error generating Current Medications from records:', err);
        currentMedications.value = null;
        logWizardEvent('current_meds_error', { error: err instanceof Error ? err.message : 'Unknown error' });
      } finally {
        isLoadingCurrentMedications.value = false;
        currentMedicationsStatus.value = '';
        if (wizardAutoFlow.value && !currentMedications.value) {
          clearWizardAutoFlow();
        }
      }
      return;
    } else {
      // Path 3: No Apple Health meds — try to extract from saved Patient Summary (one fetch, no polling)
      console.log('[Lists] No Apple Health medication records — checking saved Patient Summary');
      isInitialMedsLoading.value = false;
      currentMedicationsStatus.value = 'waiting_summary';
      isLoadingCurrentMedications.value = true;

      let medsFromSummary: string | null = null;
      try {
        const summaryRes = await fetch(`/api/patient-summary?userId=${encodeURIComponent(props.userId)}`, {
          credentials: 'include'
        });
        if (summaryRes.ok) {
          const summaryData = await summaryRes.json();
          const summaryText = summaryData.summary || summaryData.summaries?.[0] || '';
          if (summaryText) {
            console.log('[Lists] Patient Summary found (%d chars) — extracting Current Medications section', summaryText.length);
            medsFromSummary = extractMedicationsFromSummary(summaryText);
            if (medsFromSummary) {
              console.log('[Lists] Current Medications extracted from Patient Summary (%d chars)', medsFromSummary.length);
            } else {
              console.log('[Lists] Patient Summary has no "Current Medications" section');
            }
          } else {
            console.log('[Lists] No Patient Summary saved yet');
          }
        }
      } catch (err) {
        console.warn('[Lists] Error fetching Patient Summary:', err);
      }

      isLoadingCurrentMedications.value = false;
      currentMedicationsStatus.value = '';

      if (medsFromSummary) {
        currentMedications.value = medsFromSummary;
        isCurrentMedicationsEdited.value = true;
        currentMedicationsBlockTitle.value = 'Current Medications';
        logWizardEvent('current_meds_from_summary', { medsLength: medsFromSummary.length });
      } else {
        console.log('[Lists] No medications available — opening for manual entry');
        currentMedicationsBlockTitle.value = 'Current Medications as reported by the user';
        logWizardEvent('current_meds_no_records_no_summary');
      }
      startEditingCurrentMedications();
      return;
    }
  } finally {
    loadCurrentMedicationsRunning = false;
  }
};

// Remove headings from AI response (e.g., "**Current medications (non‑sexual‑function agents)**")
const removeHeadingsFromResponse = (text: string): string => {
  if (!text) return text;
  
  const lines = text.split('\n');
  const cleanedLines: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip lines that look like headings: start with **, end with **, and are relatively short
    // Also skip lines that are just "**Current medications**" or similar patterns
    if (line.startsWith('**') && line.endsWith('**') && line.length < 100) {
      // Check if it looks like a heading (contains words like "Current", "medications", "agents", etc.)
      const headingPattern = /^\*\*(current|medications?|agents?|drugs?|prescriptions?|list|summary)/i;
      if (headingPattern.test(line)) {
        continue; // Skip this line
      }
    }
    cleanedLines.push(lines[i]); // Keep original line (with original formatting)
  }
  
  return cleanedLines.join('\n').trim();
};

// Computed property for cleaned current medications (for display)
const cleanedCurrentMedications = computed(() => {
  if (!currentMedications.value) return '';
  return removeHeadingsFromResponse(currentMedications.value);
});

// Start editing current medications
const startEditingCurrentMedications = () => {
  isEditingCurrentMedications.value = true;
  editingCurrentMedications.value = currentMedications.value || '';
  editingOriginalCurrentMedications.value = currentMedications.value || '';
  clearVerifyRequirement();
};

// Cancel editing current medications
const cancelEditingCurrentMedications = () => {
  isEditingCurrentMedications.value = false;
  editingCurrentMedications.value = '';
  editingOriginalCurrentMedications.value = '';
  currentMedicationsBlockTitle.value = 'Current Medications';
};

const saveCurrentMedicationsValue = async (value: string, markEdited: boolean, clearVerify = false) => {
  if (!props.userId) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'Cannot save: user not identified.',
        timeout: 3000
      });
    }
    return;
  }
  const previousMedications = currentMedications.value;
  isSavingCurrentMedications.value = true;
  try {
    const response = await fetch('/api/user-current-medications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        currentMedications: value
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || 'Failed to save current medications');
    }

    currentMedications.value = value;
    isCurrentMedicationsEdited.value = markEdited;
    isEditingCurrentMedications.value = false;
    editingCurrentMedications.value = '';
    editingOriginalCurrentMedications.value = '';
    currentMedicationsBlockTitle.value = 'Current Medications';
    if (clearVerify) {
      clearVerifyRequirement();
    }

    emit('current-medications-saved', { value, edited: markEdited });

    // Only offer to update Patient Summary if the medications text actually changed
    if (value !== previousMedications) {
      showSummaryDialog.value = true;
    }
  } catch (err) {
    console.error('Error saving current medications:', err);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to save current medications',
        timeout: 3000
      });
    }
  } finally {
    isSavingCurrentMedications.value = false;
  }
};

// Save current medications to user document
const saveCurrentMedications = async () => {
  await saveCurrentMedicationsValue(editingCurrentMedications.value, true, false);
};

// Handle SHOW SUMMARY button click
const handleShowSummary = () => {
  showSummaryDialog.value = false;
  // Emit event to parent (MyStuffDialog) to switch to Patient Summary tab and trigger generation
  emit('show-patient-summary');
};

// Handle refresh click - show confirmation if edited
const handleRefreshCurrentMedications = () => {
  if (isCurrentMedicationsEdited.value) {
    showRefreshConfirmDialog.value = true;
  } else {
    loadCurrentMedications(true);
  }
};

// Confirm refresh - proceed with refresh
const confirmRefreshCurrentMedications = () => {
  showRefreshConfirmDialog.value = false;
  isCurrentMedicationsEdited.value = false;
  loadCurrentMedications(true);
};

// Computed property to check if we have medication records
const hasMedicationRecords = computed(() => {
  const medicationCategory = categoriesList.value.find(cat => 
    cat.name.toLowerCase().includes('medication')
  );
  return medicationCategory && medicationCategory.observations && medicationCategory.observations.length > 0;
});

// Reload categories when component is activated (if using KeepAlive)
onActivated(() => {
  if (mountInitializing) return; // onMounted still running — skip
  reloadCategories();
  if (!hasSavedResults.value && !currentMedications.value) {
    attemptAutoProcessInitialFile();
  }
});

watch(hasInitialFile, (value) => {
  if (!value) return;
  const autoProcess = sessionStorage.getItem('autoProcessInitialFile');
  const shouldAutoProcess = autoProcess === 'true' || wizardAutoFlow.value;
  if (shouldAutoProcess && !isProcessing.value && !hasSavedResults.value && !currentMedications.value) {
    attemptAutoProcessInitialFile();
  }
});

// Watch for markdown content changes and recompute categories/observations on-the-fly
watch(markdownContent, (newMarkdown) => {
  if (newMarkdown) {
    const markedMarkdown = extractCategoriesFromMarkdown(newMarkdown);
    countObservationsByPageRange(markedMarkdown);
  }
});

// Expose method to reload categories (can be called from parent)
// Must be after reloadCategories is defined
defineExpose({
  reloadCategories,
  loadWizardAutoFlow,
  attemptAutoProcessInitialFile
});
</script>

<style scoped>
.lists-container {
  max-width: 1400px;
  margin: 0 auto;
}

.markdown-preview {
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 500px;
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 0.9em;
}

.text-preview {
  white-space: pre-wrap;
  word-wrap: break-word;
  max-height: 300px;
  overflow-y: auto;
  font-family: 'Courier New', monospace;
  font-size: 0.9em;
}

.verify-highlight {
  box-shadow: 0 0 0 2px #e53935;
  border-radius: 6px;
}
</style>

