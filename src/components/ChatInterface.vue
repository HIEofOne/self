<template>
  <div class="chat-interface">
    <q-card class="full-height">
      <q-card-section class="q-pa-none full-height flex column">
        <!-- Initial load: show only spinner until wizard/chat is ready (avoids "Private AI unavailable" before wizard) -->
        <div v-if="!initialLoadComplete" class="full-height flex flex-center column" style="min-height: 280px;">
          <q-spinner size="3em" color="primary" />
          <div class="text-body2 text-grey-7 q-mt-md">Setting up...</div>
        </div>
        <template v-else>
        <!-- Phase 5: Passkey-only session warning banner -->
        <q-banner v-if="props.passkeyWithoutFolder" dense class="bg-amber-1 text-caption q-mb-none" style="flex-shrink: 0;">
          <template v-slot:avatar>
            <q-icon name="info" color="amber-8" size="sm" />
          </template>
          Your local backup will not be updated in this session. Access MAIA from your original device to keep your local folder current.
        </q-banner>
        <!-- File Info Bar -->
        <div v-if="uploadedFiles.length > 0" class="q-px-md q-pt-md q-pb-sm" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
          <div class="row items-center q-gutter-xs">
            <q-chip
              v-for="file in uploadedFiles"
              :key="file.id"
              icon="description"
              color="primary"
              text-color="white"
              size="sm"
            >
              {{ file.name }}
              <q-btn 
                flat dense round size="xs" 
                icon="visibility" 
                color="white"
                @click="viewFile(file)"
              />
              <q-btn 
                flat dense round size="xs" 
                icon="close" 
                color="white"
                @click="removeFile(file)"
              />
            </q-chip>
          </div>
        </div>
        
        <div v-if="isUploadingFile" class="q-px-md q-pt-sm q-pb-sm" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
          <div class="text-xs text-grey-6">Uploading...</div>
        </div>

        <!-- Chat Area -->
        <div ref="chatMessagesRef" class="chat-messages q-pa-md" style="flex: 1; overflow-y: auto; min-height: 0;">
          <template v-for="(msg, idx) in messages" :key="idx">
            <!-- Normal Chat Message -->
            <div 
              v-if="!editingMessageIdx.includes(idx)"
              class="q-mb-md"
              :class="msg.role === 'user' ? 'text-right' : 'text-left'"
            >
              <q-badge 
                :color="msg.role === 'user' ? 'primary' : 'secondary'"
                :label="getMessageLabel(msg)"
              />
              <div 
                class="q-mt-xs q-pa-sm rounded-borders"
                :class="msg.role === 'user' ? 'bg-blue-1' : 'bg-grey-2'"
                style="display: inline-block; max-width: 80%;"
                @click="handlePageLinkClick"
              >
                <div v-html="messageDisplayHtml[idx]"></div>
                <div class="q-mt-sm">
                  <q-btn
                    flat
                    dense
                    size="xs"
                    icon="edit"
                    color="grey-8"
                    label="Edit"
                    @click="startEditing(idx)"
                    title="Edit message"
                  />
                </div>
              </div>
            </div>
            
            <!-- Editable Chat Message -->
            <div 
              v-if="editingMessageIdx.includes(idx)"
              class="q-mb-md"
              :class="msg.role === 'user' ? 'text-right' : 'text-left'"
            >
              <q-badge 
                :color="msg.role === 'user' ? 'primary' : 'secondary'"
                :label="getMessageLabel(msg)"
              />
              <div 
                class="q-mt-xs q-pa-sm rounded-borders"
                :class="msg.role === 'user' ? 'bg-blue-1' : 'bg-grey-2'"
                style="display: inline-block; width: 90%; max-width: 90%"
              >
                <textarea 
                  v-model="msg.content" 
                  rows="8"
                  class="full-width q-pa-sm"
                  style="border: 1px solid #ccc; border-radius: 4px; resize: vertical;"
                />
                <div class="edit-buttons q-mt-sm">
                  <q-btn
                    size="sm"
                    icon="save"
                    color="primary"
                    label="Save"
                    @click="saveEditedMessage(idx)"
                  />
                  <q-btn
                    size="sm"
                    icon="close"
                    color="grey-7"
                    label="Cancel"
                    @click="cancelEditing(idx)"
                  />
                  <q-btn
                    size="sm"
                    icon="delete"
                    color="negative"
                    label="Delete Question and Response"
                    @click="confirmDeleteMessage(idx)"
                  />
                </div>
              </div>
            </div>
          </template>
          
          <div v-if="isStreaming" class="text-grey-6">
            Thinking... <q-spinner-dots size="sm" />
          </div>
        </div>
        
        <!-- Delete Confirmation Dialog -->
        <q-dialog v-model="showDeleteDialog" persistent>
          <q-card style="min-width: 350px">
            <q-card-section>
              <div class="text-h6">Delete Messages</div>
            </q-card-section>

            <q-card-section>
              <div class="text-body1">
                <p>Are you sure you want to delete this message?</p>
                <div class="message-preview q-mt-md">
                  <strong>{{ messageToDelete?.role === 'user' ? getUserLabel() : getProviderLabel() }}:</strong>
                  <div class="message-content">{{ messageToDelete?.content?.substring(0, 100) }}{{ (messageToDelete?.content?.length ?? 0) > 100 ? '...' : '' }}</div>
                </div>
                <p v-if="precedingUserMessage" class="text-caption text-grey q-mt-sm">
                  <strong>Note:</strong> This will also delete the preceding user question.
                </p>
              </div>
            </q-card-section>

            <q-card-actions align="right">
              <q-btn flat label="Cancel" color="primary" @click="showDeleteDialog = false" />
              <q-btn flat label="Delete" color="negative" @click="deleteMessageConfirmed" />
            </q-card-actions>
          </q-card>
        </q-dialog>

        <!-- Input Area with Provider Selector -->
        <div class="q-pa-md" style="flex-shrink: 0; border-top: 1px solid #eee;">
          <!-- Save Buttons -->
          <div class="row q-gutter-sm q-mb-sm" v-if="messages.length > 0">
            <div class="col"></div>
            <div class="col-auto">
              <q-btn 
                flat 
                dense 
                size="sm"
                color="primary" 
                label="SAVE LOCALLY"
                icon="save"
                @click="saveLocally"
                :disable="isStreaming || !canSaveLocally"
              />
              <q-btn 
                flat 
                dense 
                size="sm"
                color="secondary" 
                label="SAVE TO GROUP"
                icon="group"
                @click="saveToGroup"
                :disable="isStreaming || !canSaveToGroup"
              />
              <q-btn 
                flat 
                dense 
                size="sm"
                color="primary" 
                :label="`${savedChatCount} SAVED CHATS`"
                icon="history"
                @click="showSavedChats"
                :disable="!props.user?.userId"
              />
            </div>
          </div>
          
          <div class="row q-gutter-sm">
            <div class="col-auto">
              <q-select
                v-model="selectedProvider"
                :options="providerOptions"
                emit-value
                map-options
                dense
                outlined
                style="min-width: 150px"
              >
                <q-tooltip>Select AI provider: Private AI uses your knowledge base, Public AIs see only chat content</q-tooltip>
              </q-select>
            </div>
            <div class="col">
              <q-input
                v-model="inputMessage"
                label="Type your message"
                outlined
                dense
                :disable="isRequestSent"
                @keyup.enter="sendMessage"
                @focus="clearPresetPrompt"
              >
                <q-tooltip v-if="isRequestSent">Chat is disabled until your account is approved</q-tooltip>
                <q-tooltip v-else>Ask for Patient Summary to add it to the chat context and make it available to public AIs.</q-tooltip>
              </q-input>
            </div>
            <div class="col-auto">
              <q-btn 
                color="primary" 
                label="Send"
                :disable="!inputMessage || isStreaming || isRequestSent"
                @click="sendMessage"
              >
                <q-tooltip v-if="isRequestSent">Chat is disabled until your account is approved</q-tooltip>
              </q-btn>
            </div>
          </div>
          
          <!-- Status Bar -->
          <div class="row q-gutter-sm q-mt-sm q-pt-sm" style="border-top: 1px solid #eee; align-items: center;">
            <div class="col-auto">
              <q-btn 
                flat 
                dense 
                round 
                icon="attach_file" 
                class="text-grey-6" 
                :disable="isRequestSent"
                @click="triggerFileInput"
              >
                <q-tooltip v-if="isRequestSent">File import is disabled until your account is approved</q-tooltip>
                <q-tooltip v-else>Attach files to add them to the chat context</q-tooltip>
              </q-btn>
              <input
                ref="fileInput"
                type="file"
                style="display: none"
                @change="handleFileSelect"
              />
            </div>
            <div class="col" style="display: flex; align-items: center; justify-content: center;">
              <q-btn
                v-if="canAccessMyStuff"
                outline
                dense
                icon="settings"
                label="My Stuff"
                color="grey-7"
                @click="() => { myStuffInitialTab = 'files'; showMyStuffDialog = true; }"
              >
                <q-tooltip>My Stuff: Manage files, knowledge base, agent settings, and patient summary</q-tooltip>
              </q-btn>
              <!-- Status box hidden for now
              <span class="text-body2 text-grey-7" :title="contextualTip">
                <template v-for="(part, index) in parsedContextualTip" :key="index">
                  <span v-if="part.type === 'text'">{{ part.text }}</span>
                  <a
                    v-else-if="part.type === 'link'"
                    href="#"
                    class="text-primary text-underline"
                    style="cursor: pointer; text-decoration: underline;"
                    @click.prevent="handleLinkClick(part)"
                  >{{ part.text }}</a>
                </template>
              </span>
              -->
            </div>
            <div class="col-auto" style="display: flex; align-items: center; justify-content: flex-end; gap: 8px;">
              <q-btn
                v-if="!showAgentSetupDialog"
                flat
                dense
                round
                size="sm"
                icon="auto_fix_high"
                color="grey-7"
                @click="() => { wizardDismissed = false; showAgentSetupDialog = true; }"
              >
                <q-tooltip>Show wizard</q-tooltip>
              </q-btn>
              <span class="text-body2 text-grey-7">
                {{ props.user?.isTemporary ? 'Local only user:' : 'User:' }} {{ props.user?.userId || 'Guest' }}
              </span>
              <q-btn flat dense label="SIGN OUT" color="grey-8" @click="handleSignOut" />
            </div>
          </div>
        </div>
        </template>
      </q-card-section>
    </q-card>

    <q-dialog v-model="showAgentSetupDialog" persistent>
      <q-card style="min-width: 560px; max-width: 680px">
        <q-card-section>
          <div class="row items-center">
            <div class="col">
              <div class="text-h6">Setting Up Your MAIA</div>
              <div class="text-caption text-grey-7 q-mt-xs">
                Creating account for <strong>{{ props.user?.userId || 'Guest' }}</strong>. This can take 5 to 60 minutes.
              </div>
            </div>
            <q-btn flat round dense icon="close" color="grey-7" @click="dismissWizard" />
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none text-body2">
          <!-- Safari hidden file input -->
          <input
            v-if="props.folderAccessTier === 'safari'"
            ref="safariFolderInputRef"
            type="file"
            webkitdirectory
            multiple
            style="display: none"
            @change="handleSafariFolderSelected"
          />

          <!-- Action button: Choose the patient folder -->
          <div v-if="!setupFolderConnected" class="q-mb-md">
            <!-- Chrome: persistent folder access -->
            <q-btn
              v-if="localFolderSupported"
              unelevated
              color="primary"
              label="Choose the patient folder"
              icon="folder_open"
              :disable="localFolderAutoRunActive"
              @click="handlePickLocalFolder"
            />
            <!-- Safari: one-time folder read -->
            <q-btn
              v-else-if="props.folderAccessTier === 'safari'"
              unelevated
              color="primary"
              label="Select your MAIA folder"
              icon="folder_open"
              :disable="localFolderAutoRunActive"
              @click="handlePickSafariFolder"
            />
            <!-- Other browsers: file upload -->
            <q-btn
              v-else
              unelevated
              color="primary"
              label="Upload health files"
              icon="upload_file"
              :disable="isUploadingFile"
              @click="triggerFileInput"
            />
          </div>

          <!-- Progress checklist -->
          <q-list dense>
            <!-- Per-file upload lines (only when folder connected and files found) -->
            <q-item v-for="file in setupChecklistFiles" :key="`setup-file:${file.name}`" dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-spinner v-if="file.status === 'running'" size="sm" color="primary" />
                <q-icon v-else-if="file.status === 'done'" name="check_circle" color="green" size="sm" />
                <q-icon v-else-if="file.status === 'error'" name="error" color="negative" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': file.status === 'pending' }">
                  {{ file.name }}
                  <q-chip v-if="file.isAppleHealth" color="blue-6" text-color="white" size="sm" dense class="q-ml-xs">Apple Health</q-chip>
                  <span v-if="file.progress" class="text-caption q-ml-sm" :class="file.status === 'done' ? 'text-green' : 'text-primary'">{{ file.progress }}</span>
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Deploy AI Agent -->
            <q-item dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-spinner v-if="!wizardStage1Complete && agentSetupPollingActive" size="sm" color="primary" />
                <q-icon v-else-if="wizardStage1Complete" name="check_circle" color="green" size="sm" />
                <q-icon v-else-if="agentSetupTimedOut" name="error" color="negative" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': !wizardStage1Complete && !agentSetupPollingActive }">
                  Deploy AI Agent
                  <span v-if="wizardStage1Complete" class="text-green text-caption q-ml-sm">Ready</span>
                  <span v-else-if="agentSetupPollingActive" class="text-primary text-caption q-ml-sm">{{ wizardStage1StatusLine }}</span>
                  <span v-else-if="agentSetupTimedOut" class="text-negative text-caption q-ml-sm">Timed out</span>
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Index Knowledge Base -->
            <q-item v-if="setupChecklistFiles.length > 0 || stage3HasFiles" dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-spinner v-if="stage3IndexingActive" size="sm" color="primary" />
                <q-icon v-else-if="indexingStatus?.phase === 'complete'" name="check_circle" color="green" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': !stage3IndexingActive && indexingStatus?.phase !== 'complete' }">
                  Index Knowledge Base
                  <span v-if="stage3IndexingActive" class="text-primary text-caption q-ml-sm">
                    {{ stage2StatusDisplay.tokens !== '0' ? `${stage2StatusDisplay.tokens} tokens` : 'Indexing...' }}
                    {{ stage3IndexingStartedAt ? `(${formatElapsed(stage3IndexingStartedAt)})` : '' }}
                  </span>
                  <span v-else-if="indexingStatus?.phase === 'complete'" class="text-green text-caption q-ml-sm">
                    {{ stage2StatusDisplay.files }} files, {{ stage2StatusDisplay.tokens }} tokens
                  </span>
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Current Medications -->
            <q-item v-if="stage2StatusDisplay.show || wizardCurrentMedications" dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-icon v-if="wizardCurrentMedications" name="check_circle" color="green" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': !wizardCurrentMedications && !stage2StatusDisplay.completed }">
                  Current Medications
                  <span v-if="wizardCurrentMedications" class="text-green text-caption q-ml-sm">Verified</span>
                  <q-btn
                    v-else-if="stage2StatusDisplay.completed && wizardStage1Complete"
                    flat dense size="sm" color="orange-8" label="Verify"
                    class="q-ml-sm"
                    @click="handleWizardMedsAction"
                  />
                </q-item-label>
              </q-item-section>
            </q-item>

            <!-- Patient Summary -->
            <q-item v-if="stage2StatusDisplay.show || wizardPatientSummary" dense class="q-py-xs">
              <q-item-section avatar style="min-width: 28px">
                <q-icon v-if="wizardPatientSummary" name="check_circle" color="green" size="sm" />
                <q-icon v-else name="radio_button_unchecked" color="grey-4" size="sm" />
              </q-item-section>
              <q-item-section>
                <q-item-label :class="{ 'text-grey-5': !wizardPatientSummary && !stage2StatusDisplay.completed }">
                  Patient Summary
                  <span v-if="wizardPatientSummary" class="text-green text-caption q-ml-sm">Verified</span>
                  <q-btn
                    v-else-if="stage2StatusDisplay.completed && wizardStage1Complete && (!wizardHasAppleHealthFile || wizardCurrentMedications)"
                    flat dense size="sm" color="orange-8" label="Verify"
                    class="q-ml-sm"
                    @click="handleWizardSummaryAction"
                  />
                </q-item-label>
              </q-item-section>
            </q-item>
          </q-list>

          <!-- Active phase status -->
          <div v-if="localFolderAutoRunActive" class="text-caption text-primary q-mt-md">
            <q-spinner size="14px" class="q-mr-xs" />
            {{ localFolderAutoRunPhase }}
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn
            v-if="wizardStage1Complete && (indexingStatus?.phase === 'complete' || !stage3HasFiles)"
            unelevated label="Continue" color="primary"
            @click="dismissWizard"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Restore Complete sub-dialog (shown after restore flow) -->
    <q-dialog v-model="showRestoreCompleteDialog" persistent>
      <q-card style="min-width: 480px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Account Restored</div>
        </q-card-section>
        <q-card-section class="text-body2">
          Your account has been restored. The Patient Summary, Private AI knowledge base, and Saved Chats are available. Deep links that were not accessible during account dormancy are available again.
          <br /><br />
          Your private information will be in the cloud until you sign out again.
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="OK" color="primary" v-close-popup />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Wizard 60-minute timeout modal -->
    <q-dialog v-model="wizardTimeoutModalVisible" persistent>
      <q-card style="min-width: 480px; max-width: 600px">
        <q-card-section>
          <div class="text-h6">Setup Taking Longer Than Expected</div>
        </q-card-section>
        <q-card-section class="text-body2">
          <p>Your MAIA setup has been running for over 60 minutes. This may indicate an issue that needs attention.</p>
          <p>A detailed setup log (<strong>maia-setup-log.pdf</strong>) has been saved to your MAIA folder. Please email it to <a href="mailto:info@trustee.ai">info@trustee.ai</a> for tech support.</p>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="OK" color="primary" @click="wizardTimeoutModalVisible = false" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="showPrivateUnavailableDialog" persistent>
      <q-card style="min-width: 520px; max-width: 640px">
        <q-card-section>
          <div class="text-h6">Private AI Unavailable</div>
        </q-card-section>
        <q-card-section class="text-body2">
          Your Private AI agent is not available. You may access the public AIs but they will not have any access to your health records knowledge base.
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="OK" color="primary" @click="showPrivateUnavailableDialog = false" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- PDF Viewer Modal -->
    <PdfViewerModal
      v-model="showPdfViewer"
      :file="viewingFile ? {
        fileUrl: viewingFile.fileUrl,
        bucketKey: viewingFile.bucketKey,
        originalFile: viewingFile.originalFile ?? undefined,
        name: viewingFile.name
      } : undefined"
      :initial-page="pdfInitialPage"
    />

    <!-- Text/Markdown Viewer Modal -->
    <TextViewerModal
      v-model="showTextViewer"
      :file="viewingFile ? {
        fileUrl: viewingFile.fileUrl,
        bucketKey: viewingFile.bucketKey,
        originalFile: viewingFile.originalFile ?? undefined,
        name: viewingFile.name,
        content: viewingFile.content,
        type: viewingFile.type
      } : undefined"
    />

    <!-- Saved Chats Modal -->
    <SavedChatsModal
      v-model="showSavedChatsModal"
      :currentUser="props.user?.userId || ''"
      :is-deep-link-user="isDeepLink"
      @chat-selected="handleChatSelected"
      @chat-deleted="handleChatDeleted"
    />

    <!-- My Stuff Dialog -->
    <MyStuffDialog
      v-model="showMyStuffDialog"
      :userId="props.user?.userId || ''"
      :initial-tab="myStuffInitialTab"
      :request-action="wizardRequestAction"
      :messages="messages"
      :original-messages="trulyOriginalMessages.length > 0 ? trulyOriginalMessages : originalMessages"
      :wizard-active="showAgentSetupDialog"
      :rehydration-files="props.rehydrationFiles || []"
      :rehydration-active="props.rehydrationActive"
      @chat-selected="handleChatSelected"
      @indexing-started="handleIndexingStarted"
      @indexing-status-update="handleIndexingStatusUpdate"
      @indexing-finished="handleIndexingFinished"
      @files-archived="handleFilesArchived"
      @messages-filtered="handleMessagesFiltered"
      @diary-posted="handleDiaryPosted"
      @reference-file-added="handleReferenceFileAdded"
      @current-medications-saved="handleCurrentMedicationsSaved"
      @patient-summary-saved="handlePatientSummarySaved"
      @patient-summary-verified="handlePatientSummaryVerified"
      @request-action-done="wizardRequestAction = null"
      @show-patient-summary="handleMyStuffShowSummary"
      @rehydration-file-removed="handleRehydrationFileRemoved"
      @rehydration-complete="handleRehydrationComplete"
      @file-added-to-kb="handleFileAddedToKb"
      v-if="canAccessMyStuff"
    />

    <!-- Needs indexing prompt: agent exists, files exist, but KB not attached/indexed -->
    <q-dialog v-model="showNeedsIndexingPrompt" persistent>
      <q-card style="min-width: 420px; max-width: 520px">
        <q-card-section>
          <div class="text-h6">Index Your Records</div>
        </q-card-section>
        <q-card-section class="q-pt-none text-body2">
          You have imported records that are not indexed for access by your Private AI.
        </q-card-section>
        <q-card-actions align="right" class="q-gutter-sm">
          <q-btn
            flat
            label="NOT YET"
            color="grey-8"
            @click="needsIndexingPromptDismissedThisSession = true; showNeedsIndexingPrompt = false"
          />
          <q-btn
            unelevated
            label="INDEX NOW"
            color="primary"
            @click="handleNeedsIndexingIndexNow"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Document Chooser Dialog -->
    <q-dialog v-model="showDocumentChooser" persistent>
      <q-card style="min-width: 400px">
        <q-card-section>
          <div class="text-h6">Select Document</div>
          <div class="text-caption text-grey q-mt-sm">
            <span v-if="loadingUserFiles">Loading documents...</span>
            <span v-else-if="uploadedFiles.filter(f => f.type === 'pdf').length > 0 || availableUserFiles.length > 0">
              Please select which document to view.
            </span>
            <span v-else>No PDF documents available.</span>
          </div>
        </q-card-section>

        <q-card-section>
          <q-list v-if="!loadingUserFiles">
            <!-- Show PDFs from current chat first -->
            <q-item
              v-for="file in uploadedFiles.filter(f => f.type === 'pdf')"
              :key="file.id"
              clickable
              v-ripple
              @click="handleDocumentSelected(file)"
            >
              <q-item-section avatar>
                <q-icon name="description" color="primary" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ file.name }}</q-item-label>
                <q-item-label caption>From current chat</q-item-label>
              </q-item-section>
            </q-item>
            
            <!-- Show PDFs from user account -->
            <q-item
              v-for="file in availableUserFiles"
              :key="file.bucketKey"
              clickable
              v-ripple
              @click="handleDocumentSelected(file)"
            >
              <q-item-section avatar>
                <q-icon name="description" color="secondary" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ file.fileName }}</q-item-label>
                <q-item-label caption>From your files</q-item-label>
              </q-item-section>
            </q-item>
            
            <q-item v-if="uploadedFiles.filter(f => f.type === 'pdf').length === 0 && availableUserFiles.length === 0">
              <q-item-section>
                <q-item-label class="text-grey">No PDF documents found</q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
          
          <div v-else class="text-center q-pa-md">
            <q-spinner-dots size="md" />
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat label="Cancel" color="primary" @click="closeDocumentChooser" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Request Sent Modal -->
    <q-dialog v-model="showRequestSentModal" persistent>
      <q-card>
        <q-card-section>
          <div class="text-h6">Request Sent</div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <p>Request sent. Approval can take hours or days. Reload the app when contacted or if you want to check.</p>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat label="OK" color="primary" @click="showRequestSentModal = false" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Post-Indexing: Offer to update Patient Summary -->
    <q-dialog v-model="showPostIndexingSummaryPrompt" persistent>
      <q-card style="min-width: 420px; max-width: 540px">
        <q-card-section>
          <div class="text-h6">Knowledge Base Updated</div>
        </q-card-section>
        <q-card-section class="q-pt-none text-body2">
          You have changed the files in your knowledge base. Would you like to update the Patient Summary?
        </q-card-section>
        <q-card-actions align="right" class="q-gutter-sm">
          <q-btn
            flat
            label="Not yet"
            color="grey-8"
            @click="showPostIndexingSummaryPrompt = false; postIndexingSummaryDismissedThisSession = true"
          />
          <q-btn
            unelevated
            label="Update the Patient Summary"
            color="primary"
            @click="handlePostIndexingUpdateSummary"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import { useQuasar } from 'quasar';
import PdfViewerModal from './PdfViewerModal.vue';
import TextViewerModal from './TextViewerModal.vue';
import SavedChatsModal from './SavedChatsModal.vue';
import MyStuffDialog from './MyStuffDialog.vue';
import { jsPDF } from 'jspdf';
import MarkdownIt from 'markdown-it';
import {
  isFileSystemAccessSupported,
  pickLocalFolder,
  reconnectLocalFolder,
  reconnectLocalFolderWithGesture,
  listFolderFiles,
  readFileFromFolder,
  writeFileToFolder,
  readStateFile,
  writeStateFile,
  writeWeblocFile,
  type MaiaFileEntry,
  type MaiaState
} from '../utils/localFolder';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  name?: string; // legacy field for compatibility
  authorId?: string;
  authorLabel?: string;
  authorType?: 'user' | 'assistant';
  providerKey?: string;
}

interface User {
  userId: string;
  displayName: string;
  isDeepLink?: boolean;
  isTemporary?: boolean;
  isAdmin?: boolean;
}

interface DeepLinkInfo {
  shareId: string | null;
  chatId?: string | null;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: 'text' | 'pdf' | 'markdown';
  content: string;
  transcript?: string;
  originalFile: File | null;
  bucketKey?: string;
  bucketPath?: string;
  fileUrl?: string;
  uploadedAt: Date;
  isReference?: boolean;
}

interface Props {
  user?: User | null;
  isDeepLinkUser?: boolean;
  deepLinkInfo?: DeepLinkInfo | null;
  restoreChatState?: {
    messages: any[];
    uploadedFiles: any[];
    inputMessage: string;
    providerKey: string;
    providerLabel: string;
    savedChatId?: string | null;
    savedChatShareId?: string | null;
  } | null;
  rehydrationFiles?: any[] | null;
  rehydrationActive?: boolean;
  restoreActive?: boolean;
  suppressWizard?: boolean;
  folderAccessTier?: 'chrome' | 'safari' | 'basic';
  passkeyWithoutFolder?: boolean;
}

interface SignOutSnapshot {
  currentChat: {
    messages: any[];
    uploadedFiles: any[];
    inputMessage: string;
    providerKey: string;
    providerLabel: string;
    savedChatId?: string | null;
    savedChatShareId?: string | null;
  };
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'sign-out': [SignOutSnapshot];
  'restore-applied': [];
  'rehydration-complete': [payload: { hasInitialFile: boolean }];
  'rehydration-file-removed': [payload: { bucketKey?: string; fileName?: string }];
  'update:deepLinkInfo': [DeepLinkInfo | null];
  'local-folder-connected': [payload: { handle: FileSystemDirectoryHandle; folderName: string }];
  'session-dirty': [];
  'wizard-complete': [];
}>();

const $q = useQuasar();

const providers = ref<string[]>([]);
const selectedProvider = ref<string>('Private AI');
const messages = ref<Message[]>([]);
const originalMessages = ref<Message[]>([]); // Store original unfiltered messages for privacy filtering
const trulyOriginalMessages = ref<Message[]>([]); // Store truly original messages that never get overwritten (for filtering)
const inputMessage = ref('');
const isStreaming = ref(false);
const uploadedFiles = ref<UploadedFile[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const isUploadingFile = ref(false);
const showPdfViewer = ref(false);
const showTextViewer = ref(false);
const viewingFile = ref<UploadedFile | null>(null);
const pdfInitialPage = ref<number | undefined>(undefined);
const showSavedChatsModal = ref(false);
const savedChatCount = ref(0);
const showMyStuffDialog = ref(false);
const myStuffInitialTab = ref<string>('files');
const wizardRequestAction = ref<'generate-summary' | null>(null);
const contextualTip = ref('Loading...');
const editingMessageIdx = ref<number[]>([]);
const editingOriginalContent = ref<Record<number, string>>({});
const showDeleteDialog = ref(false);
const messageToDelete = ref<Message | null>(null);
const precedingUserMessage = ref<Message | null>(null);
const chatMessagesRef = ref<HTMLElement | null>(null);
const showDocumentChooser = ref(false);
const pendingPageLink = ref<{ pageNum: number; bucketKey?: string } | null>(null);
const availableUserFiles = ref<Array<{ fileName: string; bucketKey: string; fileType?: string }>>([]);
const loadingUserFiles = ref(false);
const showAgentSetupDialog = ref(false);
const showNeedsIndexingPrompt = ref(false);
const showPostIndexingSummaryPrompt = ref(false);
/** Once the user dismisses the post-indexing "Update Patient Summary?" prompt, do not show again this session. */
const postIndexingSummaryDismissedThisSession = ref(false);
/** Once the user dismisses "Index your records" with NOT YET, do not show it again this session. */
const needsIndexingPromptDismissedThisSession = ref(false);
const agentSetupStatus = ref('');
const agentSetupElapsed = ref(0);
const agentSetupTimedOut = ref(false);
const agentSetupPollingActive = ref(false);
let agentSetupTimer: ReturnType<typeof setInterval> | null = null;
const wizardOtherFilesCount = ref(0);
const wizardSlideIndex = ref(0);
const wizardHasFilesInKB = ref(false);
const wizardCurrentMedications = ref(false);
const wizardPatientSummary = ref(false);
const wizardAgentReady = ref(false);
const wizardStage1Complete = ref(false);
const wizardUploadIntent = ref<'other' | 'restore' | null>(null);
const wizardMessages = ref<Record<number, string>>({});
const wizardIntroLines = ref<string[]>([]);
const wizardIntroContainer = ref<HTMLElement | null>(null);
const wizardInlineDots = ref<HTMLElement | null>(null);
const wizardDismissed = ref(false);
const appleExportFooterSnippet = 'This summary displays certain health information made available to you by your healthcare provider and may not completely';
const appleExportFooterNormalized = appleExportFooterSnippet.toLowerCase().replace(/\s+/g, ' ').trim();
const stage3Checked = computed(() =>
  !wizardRestoreActive.value && (wizardStage2Complete.value || wizardCurrentMedications.value || wizardStage2NoDevice.value)
);
const showPrivateUnavailableDialog = ref(false);
/** Becomes true after first refreshWizardState (or immediately for deep-link). Gates spinner and "Private AI unavailable" modal. */
const initialLoadComplete = ref(false);
const wizardStage2Complete = ref(false);
const wizardStage3Complete = ref(false);
const wizardStage2Pending = ref(false);
const stage3LastImportedName = ref<string | null>(null);
const wizardIntroBodyHtml = computed(() => {
  if (wizardIntroLines.value.length === 0) {
    return '';
  }
  let firstFound = false;
  const lines: string[] = [];
  for (const line of wizardIntroLines.value) {
    if (!firstFound && line.trim().length > 0) {
      firstFound = true;
      continue;
    }
    lines.push(line);
  }
  const body = lines.join('\n');
  return body.trim().length > 0 ? markdownParser.render(body) : '';
});
const positionWizardInlineDots = async () => {
  if (wizardSlideIndex.value !== 0) return;
  await nextTick();
  const container = wizardIntroContainer.value;
  const dots = wizardInlineDots.value;
  if (!container || !dots) return;
  const lastListItem = container.querySelector('li:last-of-type');
  if (lastListItem) {
    lastListItem.appendChild(dots);
    return;
  }
  container.appendChild(dots);
};
const wizardUserStorageKey = computed(() => props.user?.userId ? `wizard-completion-${props.user.userId}` : null);
const wizardStage2NoDeviceKey = computed(() => props.user?.userId ? `wizardStage2NoDevice-${props.user.userId}` : null);
const wizardAgentSetupStartedKey = (userId: string | undefined) => userId ? `wizard_agent_setup_started_${userId}` : null;
const wizardStage3IndexingStartedKey = (userId: string | undefined) => userId ? `wizard_stage3_indexing_started_${userId}` : null;
const wizardRestoreActive = computed(() => !!props.rehydrationActive && (Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles.length > 0 : false));
const showRestoreCompleteDialog = ref(false);
const restoreIndexingActive = ref(false);
const restoreIndexingQueued = ref(false);
const wizardRestoreTargetName = ref<string | null>(null);
const wizardStage2NoDevice = ref(false);

// ── Local Folder state (File System Access API) ─────────────────
const localFolderSupported = ref(false);
const localFolderHandle = ref<FileSystemDirectoryHandle | null>(null);
const localFolderName = ref<string | null>(null);
const localFolderFiles = ref<MaiaFileEntry[]>([]);
const localFolderAutoRunActive = ref(false);
const localFolderAutoRunPhase = ref<string>('');
/** Setup log lines accumulated during the auto-run wizard. */
const setupLogLines = ref<Array<{ time: string; step: string; detail: string; ok: boolean }>>([]);
/** 60-minute timeout — show failure modal asking user to email setup log to tech support. */
const wizardTimeoutModalVisible = ref(false);
let wizardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
/** Guided wizard flow phase. Starts 'done' to avoid re-entering guided flow on reload;
 *  set to 'running' only when the wizard is actively running for the first time. */
const wizardFlowPhase = ref<'running' | 'medications' | 'summary' | 'done'>('done');

// ── Safari / basic fallback folder state ────────────────────────
/** Files collected via webkitdirectory input (Safari) or single-file input (basic). */
const safariFolderFiles = ref<File[]>([]);
const safariFolderInputRef = ref<HTMLInputElement | null>(null);
/** Name of the folder selected via webkitdirectory (extracted from webkitRelativePath). */
const safariFolderName = ref<string | null>(null);
/** True when we recovered safariFolderName from localStorage but have no live folder handle/files.
 *  Shows a prompt asking the user to re-select the folder to continue. */
const safariNeedsReselect = ref(false);

const wizardStage1StatusLine = computed(() => {
  if (wizardStage1Complete.value) return 'Ready to chat';
  const statusSuffix = agentSetupStatus.value ? ` • ${agentSetupStatus.value}` : '';
  if (agentSetupElapsed.value) {
    return `${Math.floor(agentSetupElapsed.value / 60)}m ${agentSetupElapsed.value % 60}s${statusSuffix}`;
  }
  return `<elapsed time>${statusSuffix}`;
});
const wizardStage2FileName = ref<string | null>(null);
const wizardStage3Files = ref<Array<{ name: string; isAppleHealth?: boolean; inKnowledgeBase?: boolean; bucketKey?: string; pendingKbAdd?: boolean }>>([]);
const wizardKbIndexedKeys = ref<string[]>([]);
const wizardKbTogglePending = ref<Set<string>>(new Set());
const wizardAutoCheckedKeys = ref<Set<string>>(new Set());
const wizardHasAppleHealthFile = computed(() => stage3DisplayFiles.value.some(file => !!file.isAppleHealth));
const stage2StatusDisplay = computed(() => {
  const isIndexing = indexingStatus.value?.phase === 'indexing' || indexingStatus.value?.phase === 'indexing_started';
  const files = indexingStatus.value?.filesIndexed ?? stage3DisplayFiles.value.length;
  const tokens = indexingStatus.value?.tokens ?? wizardKbTotalTokens.value ?? '0';
  const hasCompleted = indexingStatus.value?.phase === 'complete' || (!!wizardKbTotalTokens.value && !isIndexing && stage3HasFiles.value);
  if (!stage3HasFiles.value && !isIndexing && !hasCompleted) {
    return { show: false, text: '', files: 0, tokens: '0', active: false, completed: false };
  }
  if (isIndexing) {
    const elapsed = stage3IndexingStartedAt.value ? ` (${formatElapsed(stage3IndexingStartedAt.value)})` : '';
    return { show: true, text: `Indexing in-progress. Could take 5 to 60 minutes.${elapsed}`, files, tokens, active: true, completed: false };
  }
  if (hasCompleted) {
    return { show: true, text: 'Indexing complete.', files, tokens, active: false, completed: true };
  }
  return { show: true, text: 'Indexing status pending.', files, tokens, active: false, completed: false };
});
const stage3PendingUploadName = ref<string | null>(null);
const wizardKbName = ref<string | null>(null);
const wizardKbTotalTokens = ref<string | null>(null);
const wizardKbIndexedCount = ref<number | null>(null);
const stage3DisplayFiles = computed(() => {
  if (wizardRestoreActive.value) {
    const files = Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles : [];
    return files
      .filter((file: { isInitial?: boolean }) => !file?.isInitial)
      .map((file: { fileName?: string; bucketKey?: string; restored?: boolean }) => ({
        name: getFileNameFromEntry(file),
        needsRestore: true,
        isAppleHealth: false,
        inKnowledgeBase: !!file.restored,
        bucketKey: file.bucketKey || null,
        pendingKbAdd: false,
        restored: !!file.restored
      }))
      .filter((entry: { name: string }) => !!entry.name);
  }
  const seen = new Set<string>();
  return wizardStage3Files.value
    .filter(entry => !!entry.name)
    .filter(entry => {
      if (seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    })
    .map(entry => ({
      name: entry.name,
      needsRestore: false,
      isAppleHealth: entry.isAppleHealth,
      inKnowledgeBase: !!entry.inKnowledgeBase,
      bucketKey: entry.bucketKey || null,
      pendingKbAdd: !!entry.pendingKbAdd
    }));
});
const stage3HasFiles = computed(() => stage3DisplayFiles.value.length > 0);



const persistWizardCompletion = () => {
  if (!wizardUserStorageKey.value) return;
  localStorage.setItem(
    wizardUserStorageKey.value,
    JSON.stringify({
      stage2Complete: wizardStage3Complete.value,
      stage3Complete: stage3Checked.value,
      stage4Complete: wizardPatientSummary.value
    })
  );
};

// Track owner's deep link Private AI access setting
const ownerAllowDeepLinkPrivateAI = ref<boolean | null>(null);

// Track initial chat state for change detection
const currentSavedChatId = ref<string | null>(null);
const currentSavedChatShareId = ref<string | null>(null);
const lastLocalSaveSnapshot = ref<string | null>(null);
const lastGroupSaveSnapshot = ref<string | null>(null);
const hasLoadedDeepLinkChat = ref(false);

const isDeepLink = computed(() => !!props.isDeepLinkUser);
const deepLinkInfoLocal = ref<DeepLinkInfo | null>(props.deepLinkInfo || null);

watch(
  () => props.deepLinkInfo,
  (newInfo) => {
    deepLinkInfoLocal.value = newInfo || deepLinkInfoLocal.value;
  }
);

const deepLinkShareId = computed(() => deepLinkInfoLocal.value?.shareId || null);
const deepLinkChatId = computed(() => deepLinkInfoLocal.value?.chatId || null);
const canAccessMyStuff = computed(() => !isDeepLink.value && !props.user?.isDeepLink);
const restoreApplied = ref(false);

const applyRestoredChatState = (state: NonNullable<Props['restoreChatState']>) => {
  if (restoreApplied.value) return;
  if (!state) return;
  messages.value = Array.isArray(state.messages) ? state.messages : [];
  uploadedFiles.value = Array.isArray(state.uploadedFiles) ? state.uploadedFiles : [];
  inputMessage.value = state.inputMessage || '';
  currentSavedChatId.value = state.savedChatId || null;
  currentSavedChatShareId.value = state.savedChatShareId || null;

  const providerLabel = state.providerLabel || getProviderLabelFromKey(state.providerKey || '');
  if (providerLabel) {
    selectedProvider.value = providerLabel;
  }

  originalMessages.value = JSON.parse(JSON.stringify(messages.value));
  trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
  restoreApplied.value = true;
  emit('restore-applied');
};

watch(
  () => props.restoreChatState,
  (state) => {
    if (state) {
      applyRestoredChatState(state);
    }
  }
);

watch(
  () => props.rehydrationActive,
  (active) => {
    if (active) {
      wizardDismissed.value = false;
      if (!showAgentSetupDialog.value) {
        showAgentSetupDialog.value = true;
      }
    }
  },
  { immediate: true }
);

watch(
  () => (Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles.length : 0),
  (count) => {
    if (count > 0) {
      wizardDismissed.value = false;
      if (!showAgentSetupDialog.value) {
        showAgentSetupDialog.value = true;
      }
    }
  },
  { immediate: true }
);

watch(
  () => props.suppressWizard,
  async (suppressed, wasSuppressed) => {
    if (suppressed) {
      showAgentSetupDialog.value = false;
      return;
    }
    if (wasSuppressed && !suppressed) {
      wizardDismissed.value = false;
      wizardSlideIndex.value = 0;
      await refreshWizardState();
      if (!shouldHideSetupWizard.value && !showAgentSetupDialog.value && !wizardDismissed.value) {
        showAgentSetupDialog.value = true;
      }
    }
  },
  { immediate: true }
);
watch(
  () => showAgentSetupDialog.value,
  (isOpen, wasOpen) => {
    if (isOpen) {
      addSetupLogLine('Wizard Dialog', 'Setup wizard opened', true);
      wizardSlideIndex.value = 0;
      void loadWizardMessages();
      void positionWizardInlineDots();
      if (agentSetupPollingActive.value) {
        const key = wizardAgentSetupStartedKey(props.user?.userId);
        try {
          const stored = key ? sessionStorage.getItem(key) : null;
          if (stored) {
            const startedAt = parseInt(stored, 10);
            const maxAgeMs = 20 * 60 * 1000;
            if (!isNaN(startedAt) && (Date.now() - startedAt) < maxAgeMs) {
              agentSetupElapsed.value = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            }
          }
        } catch { /* ignore */ }
        stopAgentSetupTimer();
        agentSetupTimer = setInterval(() => {
          agentSetupElapsed.value += 1;
        }, 1000);
      }
    } else if (wasOpen) {
      addSetupLogLine('Wizard Dialog', 'Setup wizard closed', true);
      nextTick(() => void checkAndShowNeedsIndexingPrompt());
    }
  }
);
watch(
  () => [wizardIntroBodyHtml.value, wizardSlideIndex.value],
  () => {
    void positionWizardInlineDots();
  }
);

// Log wizard stage transitions
watch(() => wizardStage1Complete.value, (done, was) => {
  if (done && !was) addSetupLogLine('Wizard Stage', 'Stage 1 complete — Agent deployed', true);
});
watch(() => wizardStage2Complete.value, (done, was) => {
  if (done && !was) addSetupLogLine('Wizard Stage', 'Stage 2 complete — Medications imported', true);
});
watch(() => wizardStage3Complete.value, (done, was) => {
  if (done && !was) addSetupLogLine('Wizard Stage', 'Stage 3 complete — KB indexing done', true);
});
watch(() => showPrivateUnavailableDialog.value, (open) => {
  if (open) addSetupLogLine('Dialog', 'Private AI Unavailable dialog shown', false);
});
watch(() => showRestoreCompleteDialog.value, (open) => {
  if (open) addSetupLogLine('Dialog', 'Restore complete dialog shown', true);
});
watch(() => showMyStuffDialog.value, (open, was) => {
  if (open && !was) addSetupLogLine('Dialog', 'My Stuff dialog opened', true);
});

// Deferred-indexing watcher removed — indexing now starts immediately in runAutoWizard.
// wizardPatientSummary auto-dismiss watcher removed — guided flow handles this via wizardFlowPhase.

const startRestoreIndexing = async () => {
  if (!props.user?.userId) {
    restoreIndexingQueued.value = false;
    return;
  }
  try {
    const filesResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}`, {
      credentials: 'include'
    });
    if (!filesResponse.ok) {
      restoreIndexingQueued.value = false;
      return;
    }
    const filesResult = await filesResponse.json();
    const files = Array.isArray(filesResult?.files)
      ? (filesResult.files as Array<{ fileName?: string; bucketKey?: string }>)
      : [];
    const names = files
      .map(file => getFileNameFromEntry(file))
      .filter((name): name is string => !!name);
    const uniqueNames = Array.from(new Set(names));
    if (uniqueNames.length === 0) {
      restoreIndexingQueued.value = false;
      return;
    }
    wizardStage3Files.value = uniqueNames.map(name => ({ name }));
    await handleStage3Index(uniqueNames, true);
  } finally {
    restoreIndexingQueued.value = false;
  }
};

/**
 * Saved Files is the source of truth. Show "Index your records" only when Saved Files would show
 * at least one file "To be added and indexed" (i.e. !allKbFilesIndexed from /api/user-files indexingState).
 * Dismissed with NOT YET stays until reload.
 */
const checkAndShowNeedsIndexingPrompt = async () => {
  if (!props.user?.userId || props.rehydrationActive || isDeepLink.value || needsIndexingPromptDismissedThisSession.value) return;
  try {
    const [filesRes, statusRes] = await Promise.all([
      fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}`, { credentials: 'include' }),
      fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, { credentials: 'include' })
    ]);
    if (!filesRes.ok || !statusRes.ok) return;
    const filesData = await filesRes.json();
    const statusData = await statusRes.json();
    const indexingState = filesData?.indexingState;
    const allKbFilesIndexed = !!indexingState?.allKbFilesIndexed;
    if (allKbFilesIndexed) return;
    const kbIndexing = filesData?.kbIndexingStatus;
    const indexingInProgress = !!(
      kbIndexing &&
      kbIndexing.backendCompleted !== true &&
      (kbIndexing.phase === 'indexing' || kbIndexing.phase === 'indexing_started')
    );
    if (indexingInProgress) return;
    const hasAgent = !!statusData?.hasAgent;
    const fileCount = Number(statusData?.fileCount) || 0;
    const kbStatus = statusData?.kbStatus || 'none';
    const needsIndexing =
      hasAgent &&
      fileCount > 0 &&
      (kbStatus === 'none' || kbStatus === 'not_attached' || !statusData?.hasFilesInKB);
    if (needsIndexing) {
      showNeedsIndexingPrompt.value = true;
    }
  } catch {
    // ignore
  }
};

/** INDEX NOW from needs-indexing prompt: open wizard and start indexing. */
const handleNeedsIndexingIndexNow = async () => {
  showNeedsIndexingPrompt.value = false;
  wizardDismissed.value = false;
  showAgentSetupDialog.value = true;
  await nextTick();
  await startRestoreIndexing();
};

const handleRehydrationComplete = async (payload: { hasInitialFile: boolean }) => {
  emit('rehydration-complete', payload);
  let shouldAutoProcess = !!payload?.hasInitialFile;
  let hasCurrentMedications = false;
  // Always check user-status so we can suppress auto-open when medications are already saved,
  // regardless of whether the rehydration payload already indicated an initial file.
  if (props.user?.userId) {
    try {
      const statusResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      });
      if (statusResponse.ok) {
        const statusResult = await statusResponse.json();
        if (!shouldAutoProcess) {
          shouldAutoProcess = !!statusResult?.initialFile;
        }
        hasCurrentMedications = !!statusResult?.currentMedications;
      }
    } catch (error) {
      // ignore status fetch errors
    }
  }
  if (hasCurrentMedications) {
    shouldAutoProcess = false;
  }
  if (shouldAutoProcess) {
    try {
      sessionStorage.setItem('autoProcessInitialFile', 'true');
      sessionStorage.setItem('wizardMyListsAuto', 'true');
    } catch (error) {
      // ignore storage errors
    }
    myStuffInitialTab.value = 'lists';
    showMyStuffDialog.value = true;
  }
  await refreshWizardState();
  if (!shouldHideSetupWizard.value && !showAgentSetupDialog.value && !wizardDismissed.value) {
    showAgentSetupDialog.value = true;
  }
  if (!restoreIndexingQueued.value) {
    restoreIndexingQueued.value = true;
    await startRestoreIndexing();
  }
};

type UploadedFilePayload = {
  id: string;
  name: string;
  size: number;
  type: string;
  bucketKey?: string;
  bucketPath?: string;
  uploadedAt?: string | Date;
};

const buildUploadedFilePayload = (): UploadedFilePayload[] =>
  uploadedFiles.value.map(file => ({
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    bucketKey: file.bucketKey,
    bucketPath: file.bucketPath,
    uploadedAt: file.uploadedAt instanceof Date ? file.uploadedAt.toISOString() : file.uploadedAt
  }));

const buildChatHistoryPayload = () => JSON.parse(JSON.stringify(messages.value));

const getComparableChatState = () => ({
  messages: messages.value.map(msg => ({
    role: msg.role,
    content: msg.content,
    authorId: msg.authorId,
    authorLabel: msg.authorLabel,
    authorType: msg.authorType,
    providerKey: msg.providerKey
  })),
  files: uploadedFiles.value.map(file => ({
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    bucketKey: file.bucketKey,
    bucketPath: file.bucketPath
  }))
});

const currentChatSnapshot = computed(() => JSON.stringify(getComparableChatState()));

const canSaveLocally = computed(() => currentChatSnapshot.value !== lastLocalSaveSnapshot.value);
const canSaveToGroup = computed(() => currentChatSnapshot.value !== lastGroupSaveSnapshot.value);

const userResourceStatus = ref<{ hasAgent: boolean; kbStatus: string; hasKB: boolean; hasFilesInKB: boolean; workflowStage?: string | null } | null>(null);
const isRequestSent = computed(() => userResourceStatus.value?.workflowStage === 'request_sent');
const statusPollInterval = ref<ReturnType<typeof setInterval> | null>(null);
const showRequestSentModal = ref(false);
const requestSentModalShown = ref(false); // Track if modal has been shown to avoid showing it repeatedly

watch(
  () => props.user?.userId,
  () => {
    currentSavedChatId.value = null;
    currentSavedChatShareId.value = null;
    lastLocalSaveSnapshot.value = currentChatSnapshot.value;
    lastGroupSaveSnapshot.value = currentChatSnapshot.value;
  }
);

watch(
  [isDeepLink, deepLinkShareId, deepLinkChatId],
  ([, shareId, chatId], [, prevShareId, prevChatId]) => {
    if (!canAccessMyStuff.value) {
      showMyStuffDialog.value = false;
    }

    if (shareId && (shareId !== prevShareId || chatId !== prevChatId)) {
      hasLoadedDeepLinkChat.value = false;
    }

    if (chatId && currentSavedChatId.value !== chatId) {
      currentSavedChatId.value = chatId;
    }
    if (shareId && currentSavedChatShareId.value !== shareId) {
      currentSavedChatShareId.value = shareId;
    }

    if (shareId) {
      loadDeepLinkChat();
    }
  },
  { immediate: true }
);

watch(
  () => [messages.value.length, uploadedFiles.value.length],
  ([messageCount, fileCount]) => {
    if (messageCount === 0 && fileCount === 0) {
      currentSavedChatId.value = null;
      currentSavedChatShareId.value = null;
      lastLocalSaveSnapshot.value = currentChatSnapshot.value;
      lastGroupSaveSnapshot.value = currentChatSnapshot.value;
    }
  }
);

// Reset initial page when PDF viewer closes
watch(() => showPdfViewer.value, (isOpen) => {
  if (!isOpen) {
    pdfInitialPage.value = undefined;
  }
});

// Provider labels map
const providerLabels: Record<string, string> = {
  digitalocean: 'Private AI',
  anthropic: 'Anthropic',
  openai: 'ChatGPT',
  gemini: 'Gemini',
  deepseek: 'DeepSeek'
};

// Computed provider options for dropdown
const providerOptions = computed(() => {
  return providers.value.map(p => {
    const label = providerLabels[p] || p.charAt(0).toUpperCase() + p.slice(1);
    return {
      label,
      value: label
    };
  });
});

// Helper to get provider key from label
const normalizeProviderLabel = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const candidate = (value as { label?: unknown; value?: unknown }).label
      ?? (value as { value?: unknown }).value;
    if (typeof candidate === 'string') return candidate;
  }
  return '';
};

const getProviderKey = (label: unknown) => {
  const normalized = normalizeProviderLabel(label);
  const entry = Object.entries(providerLabels).find(([_, l]) => l === normalized);
  return entry ? entry[0] : normalized.toLowerCase();
};

const isPrivateAISelected = computed(() => getProviderKey(selectedProvider.value) === 'digitalocean');
const PRIVATE_AI_DEFAULT_PROMPT = 'Click SEND to get the patient summary';

const selectFirstNonPrivateProvider = () => {
  const fallback = providers.value.find(p => p !== 'digitalocean');
  if (fallback) {
    selectedProvider.value = providerLabels[fallback] || fallback;
  }
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
        userId: props.user?.userId,
        details: details || {}
      })
    });
  } catch (error) {
    // Ignore logging errors
  }
};

// Clear preset prompt when user clicks into the input
function clearPresetPrompt() {
  if (inputMessage.value === PRIVATE_AI_DEFAULT_PROMPT) {
    inputMessage.value = '';
  }
}

// Helper functions for labels
const getUserLabel = () => {
  return props.user?.userId || 'You';
};

const getProviderLabelFromKey = (providerKey: string | undefined) => {
  if (!providerKey) return 'Assistant';
  return providerLabels[providerKey] || providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
};

const getProviderLabel = () => {
  const normalized = normalizeProviderLabel(selectedProvider.value);
  return providerLabels[normalized] || normalized;
};

const getMessageLabel = (msg: Message) => {
  if (msg.authorLabel) return msg.authorLabel;
  if (msg.name) return msg.name;
  if (msg.authorType === 'assistant') {
    return getProviderLabelFromKey(msg.providerKey);
  }
  if (msg.authorId) return msg.authorId;
  return getUserLabel();
};

const normalizeMessage = (msg: Message): Message => {
  const authorType = msg.authorType || (msg.role === 'assistant' ? 'assistant' : 'user');
  const providerKey = msg.providerKey || (authorType === 'assistant' ? getProviderKey(msg.authorLabel || msg.name || selectedProvider.value) : undefined);
  const authorLabel = msg.authorLabel || msg.name || (authorType === 'assistant' ? getProviderLabelFromKey(providerKey) : msg.authorId || getUserLabel());
  const authorId = msg.authorId || (authorType === 'assistant' ? providerKey : (msg.authorLabel === getUserLabel() ? getUserLabel() : props.user?.userId));

  return {
    ...msg,
    authorType,
    providerKey,
    authorLabel,
    authorId,
    name: authorLabel
  };
};

// Load owner's deep link Private AI access setting
const loadOwnerDeepLinkSetting = async () => {
  if (!isDeepLink.value) {
    // For regular users, load their own setting
    if (!props.user?.userId) return;
    try {
      const response = await fetch(`/api/user-settings?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      });
      if (response.ok) {
        const result = await response.json();
        ownerAllowDeepLinkPrivateAI.value = result.allowDeepLinkPrivateAI !== undefined ? result.allowDeepLinkPrivateAI : true;
      } else {
        ownerAllowDeepLinkPrivateAI.value = true; // Default to enabled
      }
    } catch (error) {
      console.warn('Failed to load deep link setting, defaulting to enabled:', error);
      ownerAllowDeepLinkPrivateAI.value = true;
    }
  } else {
    // For deep link users, leave ownerAllowDeepLinkPrivateAI as null until we load the chat
    // and fetch the owner's setting in handleChatSelected. Do not default to false here,
    // or we would filter out Private AI and show "Private AI Unavailable" before we know
    // the owner's preference.
  }
};

// Fetch available providers
const loadProviders = async () => {
  try {
    const response = await fetch('/api/chat/providers');
    const data = await response.json();
    let availableProviders = data.providers;
    
    // Filter out Private AI for deep link users if owner disabled it
    if (isDeepLink.value && ownerAllowDeepLinkPrivateAI.value === false) {
      availableProviders = availableProviders.filter((p: string) => p !== 'digitalocean');
    }
    
    providers.value = availableProviders;
    
    if (providers.value.length > 0) {
      if (providers.value.includes('digitalocean')) {
        selectedProvider.value = providerLabels.digitalocean;
        showPrivateUnavailableDialog.value = false; // clear in case it was shown before refetch
      } else {
        if (initialLoadComplete.value && !showAgentSetupDialog.value && !props.restoreActive) {
          showPrivateUnavailableDialog.value = true;
        }
        selectFirstNonPrivateProvider();
      }
    }
  } catch (error) {
    console.error('Failed to load providers:', error);
    // Fallback for development
    let fallbackProviders = ['digitalocean', 'anthropic'];
    if (isDeepLink.value && ownerAllowDeepLinkPrivateAI.value === false) {
      fallbackProviders = fallbackProviders.filter(p => p !== 'digitalocean');
    }
    providers.value = fallbackProviders;
    if (providers.value.includes('digitalocean')) {
      selectedProvider.value = providerLabels.digitalocean;
      showPrivateUnavailableDialog.value = false;
    } else {
      if (initialLoadComplete.value && !showAgentSetupDialog.value && !props.restoreActive) {
        showPrivateUnavailableDialog.value = true;
      }
      selectFirstNonPrivateProvider();
    }
  }
};

watch(
  [isPrivateAISelected, () => messages.value.length, () => userResourceStatus.value?.hasAgent],
  ([isPrivate, messageCount, hasAgentRaw]) => {
    const hasAgent = Boolean(hasAgentRaw);
    const shouldPrefill = isPrivate && messageCount === 0 && hasAgent;

    if (shouldPrefill && !inputMessage.value) {
      inputMessage.value = PRIVATE_AI_DEFAULT_PROMPT;
    } else if (!shouldPrefill && inputMessage.value === PRIVATE_AI_DEFAULT_PROMPT) {
      inputMessage.value = '';
    }
  },
  { immediate: true }
);

watch(
  () => providers.value,
  (available) => {
    if (!available.length) return;
    if (available.includes('digitalocean')) {
      selectedProvider.value = providerLabels.digitalocean;
      showPrivateUnavailableDialog.value = false; // Private AI is available
      return;
    }
    if (getProviderKey(selectedProvider.value) === 'digitalocean') {
      if (initialLoadComplete.value && !showAgentSetupDialog.value && !props.restoreActive) {
        showPrivateUnavailableDialog.value = true;
      }
      selectFirstNonPrivateProvider();
    }
  },
  { immediate: true }
);

// When agent becomes ready (e.g. after wizard Stage 1 or indexing), refetch providers so Private AI appears
watch(
  () => userResourceStatus.value?.hasAgent,
  (hasAgent, prevHasAgent) => {
    if (hasAgent && !prevHasAgent) {
      loadProviders();
    }
  }
);

// Send message (streaming)
const sendMessage = async () => {
  if (!inputMessage.value || isStreaming.value || isRequestSent.value) return;
  emit('session-dirty');

  const userLabel = getUserLabel();
  const userMessage: Message = {
    role: 'user',
    content: inputMessage.value,
    authorType: 'user',
    authorId: props.user?.userId || userLabel,
    authorLabel: userLabel,
    name: userLabel
  };

  // Check if this is a patient summary request
  const isPatientSummaryRequest = /patient\s+summary/i.test(inputMessage.value);
  messages.value.push(userMessage);
  originalMessages.value = JSON.parse(JSON.stringify(messages.value)); // Keep original in sync
  // Update trulyOriginalMessages when adding new messages (but not when filtering)
  // This ensures new messages are included in the truly original set
  trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
  inputMessage.value = '';
  // Defer snapshot updates so save buttons stay enabled until the user chooses how to persist the chat
  
  isStreaming.value = true;

  try {
    // If this is a patient summary request, check for existing summary first
    if (isPatientSummaryRequest && props.user?.userId) {
      try {
        const summaryResponse = await fetch(`/api/patient-summary?userId=${encodeURIComponent(props.user.userId)}`, {
          credentials: 'include'
        });
        
        if (summaryResponse.ok) {
          const summaryData = await summaryResponse.json();
          if (summaryData.summary && summaryData.summary.trim()) {
            // Use existing summary
            const existingProviderKey = getProviderKey(selectedProvider.value);
            const existingProviderLabel = getProviderLabelFromKey(existingProviderKey);
            const summaryMessage: Message = {
              role: 'assistant',
              content: summaryData.summary,
              authorType: 'assistant',
              providerKey: existingProviderKey,
              authorId: existingProviderKey,
              authorLabel: existingProviderLabel,
              name: existingProviderLabel
            };
            messages.value.push(summaryMessage);
            // Update originalMessages and trulyOriginalMessages when loading summary from storage
            originalMessages.value = JSON.parse(JSON.stringify(messages.value));
            trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
            isStreaming.value = false;
            return;
          }
        }
      } catch (err) {
        // If fetching summary fails, continue with normal chat flow
        console.warn('Could not fetch existing summary, generating new one:', err);
      }
    }
    // Build messages with file context
    const messagesWithContext = uploadedFiles.value.length > 0
      ? messages.value.map((msg, index) => {
          // Add file context to the last user message
          if (index === messages.value.length - 1 && msg.role === 'user') {
            const filesContext = uploadedFiles.value.map(file => 
              `File: ${file.name} (${file.type})\nContent:\n${file.type === 'pdf' ? file.content : file.content}`
            ).join('\n\n');
            return {
              ...msg,
              content: `${filesContext}\n\nUser query: ${msg.content}`
            };
          }
          return msg;
        })
      : messages.value;

    const sanitizedMessages = messagesWithContext.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    
    // Convert displayed label to API key
    const providerKey = getProviderKey(selectedProvider.value);
    const shareIdForRequest = deepLinkShareId.value || currentSavedChatShareId.value || null;
    const requestOptions: Record<string, unknown> = {
      stream: true
    };
    if (shareIdForRequest) {
      requestOptions.shareId = shareIdForRequest;
    }
    const response = await fetch(
      `/api/chat/${providerKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        credentials: 'include', // Include session cookie
        body: JSON.stringify({
          messages: sanitizedMessages,
          options: requestOptions
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw { message: errorData.error || `HTTP ${response.status}`, status: response.status };
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    // Create assistant message
    const providerLabel = getProviderLabelFromKey(providerKey);
    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
      authorType: 'assistant',
      providerKey,
      authorId: providerKey,
      authorLabel: providerLabel,
      name: providerLabel
    };
    messages.value.push(assistantMessage);
    // DO NOT update originalMessages here - wait until streaming completes

    // Read stream
    while (true) {
      const { done, value } = await reader!.read();
      
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            if (data.delta) {
              assistantMessage.content += data.delta;
            }
            
            if (data.isComplete) {
              isStreaming.value = false;

              // Save patient summary if this was a summary request
              if (isPatientSummaryRequest && props.user?.userId && assistantMessage.content) {
                savePatientSummary(assistantMessage.content);
              }
              
              // Update originalMessages AFTER streaming completes with full content
              originalMessages.value = JSON.parse(JSON.stringify(messages.value));
              // Update trulyOriginalMessages when assistant response completes (new message added)
              trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
              
              return;
            }
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }
    }

    isStreaming.value = false;

    // Save patient summary if this was a summary request
    if (isPatientSummaryRequest && props.user?.userId && assistantMessage.content) {
      savePatientSummary(assistantMessage.content);
    }
    
    // Update originalMessages AFTER streaming completes with full content
    originalMessages.value = JSON.parse(JSON.stringify(messages.value));
    // Update trulyOriginalMessages when assistant response completes (new message added)
    trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
  } catch (error) {
    console.error('Chat error:', error);
    
    // Build error message
    let errorMessage = '';
    if (typeof error === 'object' && error !== null && 'status' in error) {
      const errorObj = error as { status?: unknown; message?: string };
      errorMessage = errorObj.message || 'Failed to get response';
      
      // Add special message for 429 rate limit errors
      if (errorObj.status === 429) {
        errorMessage += `\n\n**Your Private AI may be able to handle larger contexts than the ${getProviderLabel()} model.**`;
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    } else {
      errorMessage = 'Failed to get response';
    }
    
    const errorProviderKey = getProviderKey(selectedProvider.value);
    const errorProviderLabel = getProviderLabelFromKey(errorProviderKey);
    messages.value.push({
      role: 'assistant',
      content: `Error: ${errorMessage}`,
      authorType: 'assistant',
      providerKey: errorProviderKey,
      authorId: errorProviderKey,
      authorLabel: errorProviderLabel,
      name: errorProviderLabel
    });
    originalMessages.value = JSON.parse(JSON.stringify(messages.value)); // Keep original in sync
    // Update trulyOriginalMessages when error message is added (new message)
    trulyOriginalMessages.value = JSON.parse(JSON.stringify(messages.value));
    isStreaming.value = false;
  }
};

const handleSignOut = () => {
  const providerKey = getProviderKey(selectedProvider.value);
  const providerLabel = getProviderLabelFromKey(providerKey);
  emit('sign-out', {
    currentChat: {
      messages: buildChatHistoryPayload(),
      uploadedFiles: buildUploadedFilePayload(),
      inputMessage: inputMessage.value,
      providerKey,
      providerLabel,
      savedChatId: currentSavedChatId.value,
      savedChatShareId: currentSavedChatShareId.value
    }
  });
};

const stopAgentSetupTimer = () => {
  if (agentSetupTimer) {
    clearInterval(agentSetupTimer);
    agentSetupTimer = null;
  }
};

const getFileNameFromEntry = (file: { fileName?: string; bucketKey?: string }) => {
  if (file.fileName) return file.fileName;
  const key = file.bucketKey || '';
  const parts = key.split('/');
  return parts[parts.length - 1] || '';
};

const loadWizardMessages = async () => {
  try {
    const messagesResponse = await fetch('/api/setup-wizard-messages', {
      credentials: 'include'
    });
    if (messagesResponse.ok) {
      const messagesResult = await messagesResponse.json();
      const payload = messagesResult?.messages;
      if (payload?.messages && typeof payload.messages === 'object') {
        wizardMessages.value = payload.messages;
      }
      wizardIntroLines.value = typeof payload?.intro === 'string'
        ? payload.intro.split('\n')
        : [];
      return;
    }
  } catch (error) {
    // ignore message loading errors
  }
  wizardIntroLines.value = [];
};

const refreshWizardState = async () => {
  await loadWizardMessages();
  const userId = props.user?.userId;
  if (!userId) return;
  let stage3CompleteFromFiles: boolean | null = null;
  let indexingActiveFromFiles: boolean | null = null;
  let indexedCountFromFiles: number | null = null;
  let indexingJobIdFromFiles: string | null = null;
  let tokensFromFiles: string | null = null;
  try {
    const [statusResponse, filesResponse, summaryResponse] = await Promise.all([
      fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      }),
      fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}&source=wizard`, {
        credentials: 'include'
      }),
      fetch(`/api/patient-summary?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      })
    ]);

    if (wizardStage2NoDeviceKey.value) {
      try {
        wizardStage2NoDevice.value = localStorage.getItem(wizardStage2NoDeviceKey.value) === 'true';
      } catch (error) {
        wizardStage2NoDevice.value = false;
      }
    }

    let statusResult = null;
    if (statusResponse.ok) {
      statusResult = await statusResponse.json();
      if (statusResult?.kbName) {
        wizardKbName.value = statusResult.kbName;
      }
      const hasMeds = !!statusResult?.currentMedications;
      wizardCurrentMedications.value = hasMeds || wizardCurrentMedications.value;
      wizardStage2Complete.value = hasMeds || wizardStage2Complete.value;
      if (statusResult?.hasAppleFile !== undefined && typeof statusResult.hasAppleFile === 'boolean') {
        // Prefer metadata-based detection over stored flag; only use this as a fallback.
        if (!statusResult.hasAppleFile) {
          wizardStage2NoDevice.value = true;
        }
      }
      if (statusResult?.agentReady !== undefined) {
        const wasReady = wizardAgentReady.value;
        wizardAgentReady.value = !!statusResult.agentReady;
        if (wizardAgentReady.value) {
          if (!wizardStage1Complete.value) {
            wizardStage1Complete.value = true;
          }
          // Refetch only on transition (keeps existing behavior)
          if (!wasReady) {
            loadProviders();
          }
        }
      }
      if (statusResult?.initialFile && !wizardStage2FileName.value) {
        wizardStage2FileName.value = getFileNameFromEntry(statusResult.initialFile);
      }
    }

    if (statusResult) {
      userResourceStatus.value = {
        hasAgent: !!statusResult?.hasAgent,
        kbStatus: statusResult?.kbStatus || 'none',
        hasKB: !!statusResult?.hasKB,
        hasFilesInKB: !!statusResult?.hasFilesInKB,
        workflowStage: statusResult?.workflowStage || null
      };
      // Whenever server says agent is ready, ensure providers list includes Private AI (no reliance on one-time transitions)
      const agentReady = !!(statusResult?.hasAgent || statusResult?.agentReady);
      if (agentReady && !providers.value.includes('digitalocean')) {
        await loadProviders();
      }
    }

    if (filesResponse.ok) {
      const filesResult = await filesResponse.json();
      const files = Array.isArray(filesResult?.files) ? filesResult.files : [];
      const kbIndexedCount = typeof filesResult?.kbIndexedDataSourceCount === 'number'
        ? filesResult.kbIndexedDataSourceCount
        : null;
      indexedCountFromFiles = kbIndexedCount !== null ? kbIndexedCount : null;
      // Trust backendCompleted from CouchDB over the live DO API status.
      // The DO API can lag behind — it may still report isActive after the backend
      // has already detected completion, causing the wizard to never finish.
      const backendDone = filesResult?.kbIndexingStatus?.backendCompleted === true;
      indexingActiveFromFiles = backendDone ? false : !!filesResult?.kbIndexingActive;
      indexingJobIdFromFiles = filesResult?.kbIndexingJobId || filesResult?.kbLatestJobId || null;
      const liveTokenCount = Number(filesResult?.kbTotalTokens || 0);
      // Complete if backendCompleted, OR if DO API not active and either indexed count > 0 or live tokens > 0
      stage3CompleteFromFiles = backendDone || (!indexingActiveFromFiles && ((indexedCountFromFiles ?? 0) > 0 || liveTokenCount > 0));
      wizardHasFilesInKB.value = (indexedCountFromFiles ?? 0) > 0 || liveTokenCount > 0;
      tokensFromFiles = filesResult?.kbTotalTokens ? String(filesResult.kbTotalTokens) : null;
      const kbFiles = files.filter((file: { inKnowledgeBase?: boolean }) => !!file.inKnowledgeBase);
      const kbName = filesResult?.kbName || wizardKbName.value || '';
      wizardOtherFilesCount.value = kbFiles.length;
      wizardKbName.value = kbName || wizardKbName.value;
      wizardKbTotalTokens.value = tokensFromFiles || wizardKbTotalTokens.value;
      wizardKbIndexedCount.value = kbIndexedCount !== null ? kbIndexedCount : wizardKbIndexedCount.value;
      const fileEntries = files
        .map((file: { fileName?: string; name?: string; bucketKey?: string; isAppleHealth?: boolean; inKnowledgeBase?: boolean; pendingKbAdd?: boolean }) => ({
          name: getFileNameFromEntry(file) || file.fileName || file.name || (file.bucketKey ? String(file.bucketKey).split('/').pop() : ''),
          isAppleHealth: !!file?.isAppleHealth,
          inKnowledgeBase: !!file?.inKnowledgeBase,
          bucketKey: file?.bucketKey,
          pendingKbAdd: !!file?.pendingKbAdd
        }))
        .filter((entry: { name: string }) => !!entry.name);
      const hasAppleHealth = fileEntries.some((entry: { isAppleHealth?: boolean }) => entry.isAppleHealth);
      if (!hasAppleHealth) {
        wizardStage2NoDevice.value = true;
      } else if (wizardStage2NoDevice.value) {
        wizardStage2NoDevice.value = false;
      }
      if (fileEntries.length > 0) {
        wizardStage3Files.value = fileEntries;
      }
      const storedStatus = filesResult?.kbIndexingStatus || null;
      wizardKbIndexedKeys.value = Array.isArray(filesResult?.kbIndexedBucketKeys) ? filesResult.kbIndexedBucketKeys : [];
      if (fileEntries.length > 0) {
        const pendingName = stage3PendingUploadName.value;
        const pendingEntry = pendingName
          ? fileEntries.find((entry: { name: string }) => entry.name === pendingName)
          : null;
        if (pendingEntry?.bucketKey && !pendingEntry.inKnowledgeBase && !wizardAutoCheckedKeys.value.has(pendingEntry.bucketKey)) {
          wizardAutoCheckedKeys.value.add(pendingEntry.bucketKey);
          void toggleWizardKbCheckbox(pendingEntry);
        }
        if (pendingEntry) {
          stage3PendingUploadName.value = null;
          try {
            const pendingKey = props.user?.userId ? `wizardKbPendingFileName-${props.user.userId}` : 'wizardKbPendingFileName';
            localStorage.removeItem(pendingKey);
          } catch (error) {
            // ignore storage errors
          }
        }
      }
      // Persist indexing status when job already completed
      if (stage3CompleteFromFiles !== null && storedStatus) {
        const storedComplete = storedStatus?.backendCompleted === true || storedStatus?.phase === 'complete';
        indexingStatus.value = {
          active: false,
          phase: storedComplete ? 'complete' : (storedStatus.phase || 'complete'),
          tokens: storedStatus.tokens || tokensFromFiles || '0',
          filesIndexed: storedStatus.filesIndexed || indexedCountFromFiles || 0,
          progress: storedStatus.progress || 1
        };
      }
    }

    if (summaryResponse.ok) {
      const summaryData = await summaryResponse.json();
      // If server already has a patient summary, mark wizard as complete
      // (covers passkey sign-in from a different browser where localStorage is empty)
      if (summaryData?.summary && summaryData.summary.trim()) {
        wizardPatientSummary.value = true;
      }
    }

    if (wizardStage2NoDevice.value && (wizardStage2FileName.value || wizardCurrentMedications.value)) {
      wizardStage2NoDevice.value = false;
      if (wizardStage2NoDeviceKey.value) {
        try {
          localStorage.removeItem(wizardStage2NoDeviceKey.value);
        } catch (error) {
          // ignore
        }
      }
    }

      if (indexingActiveFromFiles === true) {
        wizardStage3Complete.value = false;
        if (!indexingStatus.value || indexingStatus.value.phase !== 'indexing') {
          const stage3Key = wizardStage3IndexingStartedKey(props.user?.userId);
          try {
            const stored = stage3Key ? sessionStorage.getItem(stage3Key) : null;
            if (stored) {
              const startedAt = parseInt(stored, 10);
              const maxAgeMs = 24 * 60 * 60 * 1000;
              if (!isNaN(startedAt) && (Date.now() - startedAt) < maxAgeMs) {
                stage3IndexingStartedAt.value = startedAt;
              } else {
                if (stage3Key) sessionStorage.removeItem(stage3Key);
                stage3IndexingStartedAt.value = Date.now();
                if (stage3Key) sessionStorage.setItem(stage3Key, String(stage3IndexingStartedAt.value));
              }
            } else {
              stage3IndexingStartedAt.value = Date.now();
              if (stage3Key) sessionStorage.setItem(stage3Key, String(stage3IndexingStartedAt.value));
            }
          } catch {
            stage3IndexingStartedAt.value = Date.now();
          }
          stage3IndexingCompletedAt.value = null;
          indexingStatus.value = {
            active: true,
            phase: 'indexing',
            tokens: tokensFromFiles || '0',
            filesIndexed: indexedCountFromFiles || 0,
            progress: 0
          };
          startStage3ElapsedTimer();
          if (indexingJobIdFromFiles) {
            if (stage3IndexingPoll.value) {
              clearInterval(stage3IndexingPoll.value);
            }
            let prevPollState2 = '';
            stage3IndexingPoll.value = setInterval(async () => {
              try {
                const statusResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user?.userId || '')}&source=wizard`, {
                  credentials: 'include'
                });
                if (!statusResponse.ok) {
                  throw new Error(`Indexing status error: ${statusResponse.status}`);
                }
                const statusResult = await statusResponse.json();
                const storedStatus = statusResult?.kbIndexingStatus || {};
                const liveActive = !!statusResult?.kbIndexingActive;
                const backendDone = storedStatus.backendCompleted === true;
                // Fix: '0' is truthy in JS, so use Number() to properly fall through to kbTotalTokens
                const storedTokens = storedStatus.tokens;
                const liveTokens = statusResult?.kbTotalTokens ? String(statusResult.kbTotalTokens) : '0';
                const tokens = (Number(storedTokens) > 0) ? storedTokens : liveTokens;
                const elapsedPollMs = stage3IndexingStartedAt.value ? Date.now() - stage3IndexingStartedAt.value : 0;
                const elapsedPollMin = Math.floor(elapsedPollMs / 60000);
                const elapsedPollSec = Math.floor((elapsedPollMs % 60000) / 1000);
                // Only log to console when state changes
                const curPollState2 = `${backendDone}|${liveActive}|${tokens}|${storedStatus.phase || '?'}`;
                if (curPollState2 !== prevPollState2) {
                  console.log(`[KB-POLL] backendCompleted=${backendDone} liveActive=${liveActive} tokens=${tokens} phase=${storedStatus.phase || '?'} elapsed=${elapsedPollMin}m${elapsedPollSec}s`);
                  prevPollState2 = curPollState2;
                }
                if (storedStatus.jobId && indexingJobIdFromFiles && storedStatus.jobId !== indexingJobIdFromFiles) {
                  return;
                }
                if (indexingStatus.value) {
                  indexingStatus.value.phase = storedStatus.phase || indexingStatus.value.phase;
                  indexingStatus.value.tokens = tokens;
                  indexingStatus.value.filesIndexed = storedStatus.filesIndexed || 0;
                  indexingStatus.value.progress = storedStatus.progress || 0;
                }
                // Log progress every ~60s (every 6th poll at 10s interval)
                if (elapsedPollMs > 0 && Math.floor(elapsedPollMs / 60000) !== Math.floor((elapsedPollMs - 10000) / 60000)) {
                  addSetupLogLine('Indexing Progress', `${elapsedPollMin}m elapsed — tokens=${tokens} files=${storedStatus.filesIndexed || 0} active=${liveActive} backendDone=${backendDone}`, true);
                }
                // Also treat as complete if DO API says not active and tokens > 0
                // (covers edge case where backend polling crashed before setting backendCompleted)
                const inferredComplete = !liveActive && Number(tokens) > 0;
                // Also complete if DO API says not active for > 5 minutes (handles 0-token edge case)
                const timedOutInactive = !liveActive && !backendDone && elapsedPollMs > 5 * 60 * 1000;
                // Client-side safety net: if tokens > 0 for > 7 minutes, complete even if liveActive=true
                const tokenTimeoutComplete = !backendDone && !inferredComplete && Number(tokens) > 0 && elapsedPollMs > 7 * 60 * 1000;
                // Pure time-based fallback: 20+ min with no completion signal at all (0-token "no changes" case)
                const pureTimeoutComplete = !backendDone && !inferredComplete && !tokenTimeoutComplete && elapsedPollMs > 20 * 60 * 1000;
                const isCompleted = backendDone || inferredComplete || timedOutInactive || tokenTimeoutComplete || pureTimeoutComplete;
                const completionReason = backendDone ? 'backendCompleted' : inferredComplete ? 'inferredComplete' : timedOutInactive ? 'timedOutInactive' : tokenTimeoutComplete ? 'tokenTimeout' : 'pureTimeout';
                if (isCompleted) {
                  console.log(`[KB-POLL] ✅ Indexing complete: tokens=${tokens} files=${storedStatus.filesIndexed || 0} reason=${completionReason} elapsed=${elapsedPollMin}m${elapsedPollSec}s`);
                  if (stage3IndexingPoll.value) {
                    clearInterval(stage3IndexingPoll.value);
                    stage3IndexingPoll.value = null;
                  }
                  if (indexingStatus.value) {
                    indexingStatus.value.active = false;
                    indexingStatus.value.phase = 'complete';
                  }
                  stage3IndexingCompletedAt.value = Date.now();
                  stopStage3ElapsedTimer();
                  try {
                    const k = wizardStage3IndexingStartedKey(props.user?.userId);
                    if (k) sessionStorage.removeItem(k);
                  } catch { /* ignore */ }
                  refreshWizardState();
                }
              } catch (pollError) {
                console.warn('[KB-POLL] Error:', pollError);
              }
            }, 10000);
          }
        }
      } else if (stage3CompleteFromFiles !== null) {
        wizardStage3Complete.value = stage3CompleteFromFiles;
        if (stage3CompleteFromFiles && !indexingStatus.value) {
          indexingStatus.value = {
            active: false,
            phase: 'complete',
            tokens: tokensFromFiles || '0',
            filesIndexed: indexedCountFromFiles || 0,
            progress: 1
          };
        }
        if (indexingStatus.value?.phase !== 'indexing') {
          stopStage3ElapsedTimer();
        }
      }
      if (wizardUserStorageKey.value) {
        const stored = localStorage.getItem(wizardUserStorageKey.value);
        if (stored) {
          try {
            const parsed = JSON.parse(stored);
            if (!indexingActiveFromFiles && !stage3IndexingActive.value) {
              wizardStage3Complete.value = !!parsed.stage2Complete || wizardStage3Complete.value;
            }
            wizardStage2Complete.value = !!parsed.stage3Complete || wizardStage2Complete.value;
            wizardPatientSummary.value = !!parsed.stage4Complete || wizardPatientSummary.value;
          } catch (error) {
            // Ignore malformed storage
          }
        }
      }
      persistWizardCompletion();
  } catch (error) {
    console.warn('Failed to refresh setup wizard state:', error);
  }
};

const shouldHideSetupWizard = computed(() =>
  (!wizardRestoreActive.value && wizardPatientSummary.value) || !!props.user?.isAdmin || !!props.suppressWizard
);

const savePatientSummary = async (summary: string) => {
  if (!props.user?.userId || !summary) return;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.user.userId,
        summary: summary
      })
    });
    
    if (!response.ok) {
      console.error('Failed to save patient summary');
    }
  } catch (error) {
    console.error('Error saving patient summary:', error);
  }
};

const triggerFileInput = () => {
  if (isRequestSent.value) return;
  fileInput.value?.click();
};

const handleWizardFileSelect = () => {
  logWizardEvent('stage2_file_selected', { tab: 'wizard' });
  wizardUploadIntent.value = null;
  refreshWizardState();
};

const toggleWizardKbCheckbox = async (file: { bucketKey?: string | null; inKnowledgeBase?: boolean }) => {
  const userId = props.user?.userId;
  if (!userId || !file?.bucketKey) return;
  const bucketKey = file.bucketKey;
  if (wizardKbTogglePending.value.has(bucketKey)) return;
  wizardKbTogglePending.value.add(bucketKey);
  const nextValue = !file.inKnowledgeBase;
  try {
    const response = await fetch('/api/toggle-file-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId,
        bucketKey,
        inKnowledgeBase: nextValue
      })
    });
    if (!response.ok) {
      throw new Error(`Failed to update KB selection (${response.status})`);
    }
    file.inKnowledgeBase = nextValue;
    wizardStage3Files.value = wizardStage3Files.value.map(entry =>
      entry.bucketKey === bucketKey ? { ...entry, inKnowledgeBase: nextValue } : entry
    );
    // File moved to/from KB folder or archived — remove from chat badges and context
    handleFilesArchived([bucketKey]);
    await refreshWizardState();
  } catch (error) {
    console.error('Failed to toggle KB selection:', error);
  } finally {
    wizardKbTogglePending.value.delete(bucketKey);
  }
};

const handleWizardMedsAction = () => {
  if (!props.user?.userId) return;
  const appleFile = stage3DisplayFiles.value.find(file => file.isAppleHealth && file.bucketKey);
  try {
    sessionStorage.setItem('autoProcessInitialFile', 'true');
    sessionStorage.setItem('wizardMyListsAuto', 'true');
  } catch (error) {
    // ignore storage errors
  }
  myStuffInitialTab.value = 'lists';
  showMyStuffDialog.value = true;
  if (appleFile?.bucketKey) {
    void fetch('/api/files/lists/process-initial-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        bucketKey: appleFile.bucketKey,
        fileName: appleFile.name
      })
    });
  }
};

const handleWizardSummaryAction = () => {
  if (!props.user?.userId) return;
  myStuffInitialTab.value = 'summary';
  showMyStuffDialog.value = true;
  wizardRequestAction.value = 'generate-summary';
  wizardPatientSummary.value = false;
};

const dismissWizard = () => {
  addSetupLogLine('Wizard Action', 'User dismissed setup wizard', true);
  wizardDismissed.value = true;
  showAgentSetupDialog.value = false;
  stopAgentSetupTimer();
  if (initialLoadComplete.value && providers.value.length > 0 && !providers.value.includes('digitalocean')) {
    showPrivateUnavailableDialog.value = true;
    selectFirstNonPrivateProvider();
  }
};

// ── Local Folder: pick, auto-run, PDF log ────────────────────────

const SETUP_LOG_JSON = 'maia-setup-log.json';

/** Parse navigator.userAgent into a human-readable string, e.g. "Chrome 145 on macOS". */
const parseUserAgent = (): string => {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  // Detect browser
  let browser = 'Unknown browser';
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const firefoxMatch = ua.match(/Firefox\/(\d+)/);
  const safariMatch = ua.match(/Version\/(\d+).*Safari/);
  const edgeMatch = ua.match(/Edg\/(\d+)/);
  if (edgeMatch) browser = `Edge ${edgeMatch[1]}`;
  else if (chromeMatch) browser = `Chrome ${chromeMatch[1]}`;
  else if (firefoxMatch) browser = `Firefox ${firefoxMatch[1]}`;
  else if (safariMatch) browser = `Safari ${safariMatch[1]}`;
  // Detect OS
  let os = 'Unknown OS';
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) os = 'macOS';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  return `${browser} on ${os}`;
};

// Steps that should only appear once per session (watcher-driven, can re-fire on remount)
const oneTimeLogSteps = new Set(['Indexing Complete', 'Current Medications', 'Wizard Flow']);

const addSetupLogLine = (step: string, detail: string, ok: boolean) => {
  // Deduplicate within current session
  const lastSessionIdx = setupLogLines.value.map(l => l.step).lastIndexOf('Session Start');
  const sessionLines = lastSessionIdx >= 0 ? setupLogLines.value.slice(lastSessionIdx) : setupLogLines.value;
  // For one-time steps, skip if ANY entry in the session has the same step + detail
  if (oneTimeLogSteps.has(step) && sessionLines.some(l => l.step === step && l.detail === detail)) return;
  // For other steps, skip only if the immediately preceding entry is identical
  const last = sessionLines[sessionLines.length - 1];
  if (last && last.step === step && last.detail === detail) return;
  setupLogLines.value.push({
    time: new Date().toISOString(),
    step,
    detail,
    ok
  });
};

const persistSetupLogJson = async () => {
  if (!localFolderHandle.value) return;
  try {
    await writeFileToFolder(localFolderHandle.value, SETUP_LOG_JSON, JSON.stringify(setupLogLines.value, null, 2));
  } catch { /* ignore */ }
};

const restoreSetupLogFromJson = async () => {
  if (!localFolderHandle.value) return;
  try {
    const file = await readFileFromFolder(localFolderHandle.value, SETUP_LOG_JSON);
    if (!file) return;
    const parsed = JSON.parse(await file.text());
    if (Array.isArray(parsed)) setupLogLines.value = parsed;
  } catch { /* ignore */ }
};

/** User clicks "Select your MAIA folder" — opens directory picker, scans files, starts auto-run. */
const handlePickLocalFolder = async () => {
  if (!props.user?.userId) return;
  const result = await pickLocalFolder(props.user.userId);
  if (!result) return; // user cancelled
  localFolderHandle.value = result.handle;
  localFolderName.value = result.folderName;
  emit('local-folder-connected', { handle: result.handle, folderName: result.folderName });
  // Restore previous session history before adding new entries
  await restoreSetupLogFromJson();

  // Detect user change — if the log has entries from a different user, insert a divider
  const prevUserEntry = [...setupLogLines.value].reverse().find(l => l.step === 'Session Info' && l.detail?.startsWith('User: '));
  const prevUserId = prevUserEntry ? prevUserEntry.detail.replace('User: ', '') : null;
  if (prevUserId && prevUserId !== props.user.userId) {
    addSetupLogLine('Session Change', `--- Account changed from ${prevUserId} to ${props.user.userId} ---`, true);
  }

  addSetupLogLine('Session Info', `User: ${props.user.userId}`, true);
  addSetupLogLine('Session Info', `Browser: ${parseUserAgent()}`, true);
  addSetupLogLine('Session Info', `App URL: ${window.location.origin}`, true);
  addSetupLogLine('Folder Selected', `Folder: ${result.folderName}`, true);

  // Write maia.webloc shortcut immediately (with userId if available; patient name added at wizard completion)
  try {
    await writeWeblocFile(result.handle, window.location.origin, {
      userId: props.user?.userId || undefined
    });
    addSetupLogLine('Shortcut Created', 'maia.webloc written to folder', true);
  } catch (e) {
    addSetupLogLine('Shortcut Error', `Failed to write maia.webloc: ${e instanceof Error ? e.message : 'Unknown'}`, false);
  }

  // Scan folder for PDF files
  try {
    const files = await listFolderFiles(result.handle, { extensions: ['pdf'] });
    localFolderFiles.value = files;
    addSetupLogLine('Folder Scanned', `Found ${files.length} PDF file(s): ${files.map(f => f.name).join(', ') || '(none)'}`, true);
  } catch (e) {
    localFolderFiles.value = [];
    addSetupLogLine('Folder Scan', `Error scanning folder: ${e instanceof Error ? e.message : 'Unknown'}`, false);
  }

  // Start 60-minute timeout
  wizardTimeoutTimer = setTimeout(async () => {
    if (showAgentSetupDialog.value && localFolderHandle.value) {
      addSetupLogLine('Timeout', 'Wizard timed out after 60 minutes', false);
      await generateSetupLogPdf();
      wizardTimeoutModalVisible.value = true;
    }
  }, 60 * 60 * 1000);

  // Start auto-run wizard — set guided flow phase to 'running'
  wizardFlowPhase.value = 'running';
  await runAutoWizard();
};

/** Safari: user clicks "Select your MAIA folder" — opens webkitdirectory input, scans files, starts auto-run. */
const handlePickSafariFolder = () => {
  safariFolderInputRef.value?.click();
};

/** Safari: files selected via webkitdirectory input */
const handleSafariFolderSelected = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) return;
  if (!props.user?.userId) return;

  // Collect PDF files from the folder
  const allFiles = Array.from(input.files);
  const pdfs = allFiles.filter(f => f.name.toLowerCase().endsWith('.pdf') && !f.name.startsWith('.'));

  // Extract folder name from webkitRelativePath (e.g. "MAIA/file.pdf" → "MAIA")
  const firstPath = allFiles[0]?.webkitRelativePath || '';
  const folderName = firstPath.split('/')[0] || 'Selected Folder';
  safariFolderName.value = folderName;
  safariNeedsReselect.value = false;
  safariFolderFiles.value = pdfs;

  // Persist safari folder name so we can recover wizard state on reload
  try {
    const sfKey = `safariFolderName-${props.user.userId}`;
    localStorage.setItem(sfKey, folderName);
  } catch { /* ignore */ }

  // Populate localFolderFiles with compatible entries (no fileHandle — Safari doesn't provide one)
  localFolderFiles.value = pdfs.map(f => ({
    name: f.name,
    size: f.size,
    lastModified: f.lastModified,
    fileHandle: null as any, // Not available in Safari
  }));

  localFolderName.value = folderName;
  addSetupLogLine('Session Info', `User: ${props.user.userId}`, true);
  addSetupLogLine('Session Info', `Browser: ${parseUserAgent()} (folder read-only mode)`, true);
  addSetupLogLine('Folder Selected', `Folder: ${folderName} (${pdfs.length} PDF files)`, true);

  // Start 60-minute timeout
  wizardTimeoutTimer = setTimeout(async () => {
    if (showAgentSetupDialog.value) {
      addSetupLogLine('Timeout', 'Wizard timed out after 60 minutes', false);
      wizardTimeoutModalVisible.value = true;
    }
  }, 60 * 60 * 1000);

  wizardFlowPhase.value = 'running';
  await runSafariFolderWizard(pdfs);
};

/** Safari auto-wizard: upload files from webkitdirectory → deploy agent → index KB.
 *  Same flow as Chrome wizard but files come from File objects, not FileSystemFileHandle. */
const runSafariFolderWizard = async (files: File[]) => {
  if (!props.user?.userId) return;
  localFolderAutoRunActive.value = true;
  addSetupLogLine('Session Start', '--- New Session (folder read-only mode) ---', true);

  try {
    // Phase 1: Upload PDFs
    localFolderAutoRunPhase.value = 'Uploading files...';
    const MAIA_GENERATED_FILES = ['maia-setup-log.pdf', 'maia-setup-log.json'];
    const filesToUpload = files.filter(f => !MAIA_GENERATED_FILES.includes(f.name.toLowerCase()));
    addSetupLogLine('Upload Phase', `Starting upload of ${filesToUpload.length} PDF file(s)`, true);

    let uploadedCount = 0;
    let appleHealthCount = 0;
    for (const file of filesToUpload) {
      try {
        const maxSize = 50 * 1024 * 1024;
        if (file.size > maxSize) {
          addSetupLogLine('Upload Skip', `${file.name}: too large (${(file.size / 1024 / 1024).toFixed(1)}MB)`, false);
          continue;
        }
        localFolderAutoRunPhase.value = `Uploading ${file.name}...`;
        const uploadFormData = new FormData();
        uploadFormData.append('file', file);
        const uploadResponse = await fetch('/api/files/upload', {
          method: 'POST',
          credentials: 'include',
          body: uploadFormData
        });
        if (!uploadResponse.ok) {
          const errorData = await uploadResponse.json().catch(() => ({}));
          addSetupLogLine('Upload Failed', `${file.name}: ${errorData.message || errorData.error || 'Upload error'}`, false);
          continue;
        }
        const uploadResult = await uploadResponse.json();

        // Detect Apple Health
        let isAppleHealth = false;
        try {
          isAppleHealth = await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey);
          if (isAppleHealth) appleHealthCount++;
        } catch { /* ignore detection errors */ }

        // Save file metadata
        await fetch('/api/user-file-metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.user!.userId,
            fileMetadata: {
              fileName: uploadResult.fileInfo.fileName,
              bucketKey: uploadResult.fileInfo.bucketKey,
              bucketPath: uploadResult.fileInfo.userFolder,
              fileSize: uploadResult.fileInfo.size,
              fileType: 'pdf',
              uploadedAt: uploadResult.fileInfo.uploadedAt,
              isAppleHealth
            },
            updateInitialFile: false
          })
        });

        uploadedCount++;
        addSetupLogLine('File Uploaded', `${file.name} (${(file.size / 1024).toFixed(0)} KB)${isAppleHealth ? ' [Apple Health]' : ''}`, true);
      } catch (e) {
        addSetupLogLine('Upload Error', `${file.name}: ${e instanceof Error ? e.message : 'Unknown'}`, false);
      }
    }
    addSetupLogLine('Upload Complete', `${uploadedCount} of ${filesToUpload.length} file(s) uploaded${appleHealthCount > 0 ? `, ${appleHealthCount} Apple Health` : ''}`, uploadedCount > 0);

    // Refresh wizard state and proceed with indexing (same as Chrome path)
    await refreshWizardState();
    addSetupLogLine('State Refreshed', `Server knows about ${wizardStage3Files.value.length} file(s)`, true);

    // Phase 2: Check agent
    localFolderAutoRunPhase.value = 'Checking agent deployment...';
    addSetupLogLine('Agent Status', wizardStage1Complete.value ? 'Agent ready' : 'Agent deployment in progress', true);

    // Phase 3: Index KB
    if (uploadedCount > 0) {
      localFolderAutoRunPhase.value = 'Starting knowledge base indexing...';
      try {
        const fileNames = wizardStage3Files.value.map(f => f.name);
        if (fileNames.length > 0) {
          addSetupLogLine('Indexing Start', `Sending ${fileNames.length} file(s) for indexing: ${fileNames.join(', ')}`, true);
          await handleStage3Index(fileNames, false);
          addSetupLogLine('Indexing Started', `KB indexing kicked off for ${fileNames.length} file(s)`, true);
          localFolderAutoRunPhase.value = 'Knowledge base indexing in progress...';
        }
      } catch (e) {
        addSetupLogLine('Indexing Error', `${e instanceof Error ? e.message : 'Unknown'}`, false);
      }
    }

    if (uploadedCount > 0) {
      localFolderAutoRunPhase.value = 'Knowledge base indexing in progress...';
    } else {
      localFolderAutoRunPhase.value = 'Setup complete';
    }
  } catch (e) {
    addSetupLogLine('Auto-Run Error', `${e instanceof Error ? e.message : 'Unknown error'}`, false);
    localFolderAutoRunPhase.value = 'Setup completed with errors';
  } finally {
    localFolderAutoRunActive.value = false;
  }
};

/** Try to silently reconnect to a previously chosen local folder. */
const tryReconnectLocalFolder = async () => {
  if (!props.user?.userId || !isFileSystemAccessSupported()) return;
  const result = await reconnectLocalFolder(props.user.userId);
  if (!result) return;
  localFolderHandle.value = result.handle;
  localFolderName.value = result.folderName;
  emit('local-folder-connected', { handle: result.handle, folderName: result.folderName });
  // Scan folder for new files silently
  try {
    const files = await listFolderFiles(result.handle, { extensions: ['pdf'] });
    localFolderFiles.value = files;
  } catch {
    // ignore — folder may be unavailable
  }
  // Restore previous session history
  await restoreSetupLogFromJson();
};

/** Auto-run wizard: upload folder files → deploy agent → index KB → detect Apple Health → generate summary. */
const runAutoWizard = async () => {
  if (!props.user?.userId || !localFolderHandle.value) return;
  localFolderAutoRunActive.value = true;
  // Add session separator (preserves full history from previous sessions)
  addSetupLogLine('Session Start', '--- New Session ---', true);

  try {
    // Phase 1: Upload PDFs from folder to Spaces
    localFolderAutoRunPhase.value = 'Uploading files...';
    const MAIA_GENERATED_FILES = ['maia-setup-log.pdf', 'maia-setup-log.json'];
    const filesToUpload = localFolderFiles.value.filter(f => {
      const name = f.name.toLowerCase();
      return name.endsWith('.pdf') && !MAIA_GENERATED_FILES.includes(name);
    });
    addSetupLogLine('Upload Phase', `Starting upload of ${filesToUpload.length} PDF file(s)`, true);
    let uploadedCount = 0;
    let appleHealthCount = 0;
    for (const fileEntry of filesToUpload) {
      try {
        const file = await fileEntry.fileHandle.getFile();
        // Check size
        const maxSize = 50 * 1024 * 1024;
        if (file.size > maxSize) {
          addSetupLogLine('Upload Skip', `${file.name}: too large (${(file.size / 1024 / 1024).toFixed(1)}MB)`, false);
          continue;
        }
        localFolderAutoRunPhase.value = `Uploading ${file.name}...`;
        // Upload to bucket
        const uploadFormData = new FormData();
        uploadFormData.append('file', file);
        const uploadResponse = await fetch('/api/files/upload', {
          method: 'POST',
          credentials: 'include',
          body: uploadFormData
        });
        if (!uploadResponse.ok) {
          const errorData = await uploadResponse.json().catch(() => ({}));
          addSetupLogLine('Upload Failed', `${file.name}: ${errorData.message || errorData.error || 'Upload error'}`, false);
          continue;
        }
        const uploadResult = await uploadResponse.json();

        // Detect Apple Health
        let isAppleHealth = false;
        try {
          isAppleHealth = await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey);
          if (isAppleHealth) appleHealthCount++;
        } catch { /* ignore detection errors */ }

        // Save file metadata
        await fetch('/api/user-file-metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.user!.userId,
            fileMetadata: {
              fileName: uploadResult.fileInfo.fileName,
              bucketKey: uploadResult.fileInfo.bucketKey,
              bucketPath: uploadResult.fileInfo.userFolder,
              fileSize: uploadResult.fileInfo.size,
              fileType: 'pdf',
              uploadedAt: uploadResult.fileInfo.uploadedAt,
              isAppleHealth
            },
            updateInitialFile: false
          })
        });

        uploadedCount++;
        addSetupLogLine('File Uploaded', `${file.name} (${(file.size / 1024).toFixed(0)} KB)${isAppleHealth ? ' [Apple Health]' : ''}`, true);
      } catch (e) {
        addSetupLogLine('Upload Error', `${fileEntry.name}: ${e instanceof Error ? e.message : 'Unknown'}`, false);
      }
    }
    addSetupLogLine('Upload Complete', `${uploadedCount} of ${filesToUpload.length} file(s) uploaded${appleHealthCount > 0 ? `, ${appleHealthCount} Apple Health` : ''}`, uploadedCount > 0);

    // Refresh wizard state to pick up new files
    await refreshWizardState();
    addSetupLogLine('State Refreshed', `Server knows about ${wizardStage3Files.value.length} file(s)`, true);

    // Phase 2: Check agent deployment status
    localFolderAutoRunPhase.value = 'Checking agent deployment...';
    if (!wizardStage1Complete.value) {
      addSetupLogLine('Agent Status', 'Agent deployment in progress', true);
    } else {
      addSetupLogLine('Agent Status', 'Agent ready', true);
    }

    // Phase 3: Move files to KB and trigger indexing immediately (KB creation is independent of agent)
    if (uploadedCount > 0) {
      localFolderAutoRunPhase.value = 'Starting knowledge base indexing...';
      try {
        const fileNames = wizardStage3Files.value.map(f => f.name);
        if (fileNames.length > 0) {
          addSetupLogLine('Indexing Start', `Sending ${fileNames.length} file(s) for indexing: ${fileNames.join(', ')}`, true);
          await handleStage3Index(fileNames, false);
          addSetupLogLine('Indexing Started', `KB indexing kicked off for ${fileNames.length} file(s)`, true);
          localFolderAutoRunPhase.value = 'Knowledge base indexing in progress...';
        }
      } catch (e) {
        addSetupLogLine('Indexing Error', `${e instanceof Error ? e.message : 'Unknown'}`, false);
      }
    }

    // Phase 4: Generate setup log PDF
    await generateSetupLogPdf();

    // Phase 5: Write initial maia-state.json
    await saveStateToLocalFolder();

    if (uploadedCount > 0) {
      localFolderAutoRunPhase.value = 'Knowledge base indexing in progress...';
    } else {
      localFolderAutoRunPhase.value = 'Setup complete';
    }
  } catch (e) {
    addSetupLogLine('Auto-Run Error', `${e instanceof Error ? e.message : 'Unknown error'}`, false);
    localFolderAutoRunPhase.value = 'Setup completed with errors';
  } finally {
    localFolderAutoRunActive.value = false;
  }
};

/** Generate maia-setup-log.pdf from setupLogLines and write to local folder. */
const generateSetupLogPdf = async () => {
  if (!localFolderHandle.value) return;
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const maxWidth = pageWidth - margin * 2;
  let y = 20;

  // Header
  doc.setFontSize(18);
  doc.text('MAIA Setup Log', margin, y);
  y += 10;
  doc.setFontSize(10);
  doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
  y += 6;
  doc.text(`User: ${props.user?.userId || 'unknown'}`, margin, y);
  y += 6;
  doc.text(`App URL: ${window.location.origin}`, margin, y);
  y += 6;
  doc.text(`Folder: ${localFolderName.value || 'unknown'}`, margin, y);
  y += 6;
  const ua = parseUserAgent();
  doc.text(`Browser: ${ua}`, margin, y);
  y += 8;

  // Summary section
  doc.setFontSize(11);
  doc.text('Summary', margin, y);
  y += 6;
  doc.setFontSize(9);
  // Count files only from the LAST session (after the last "Session Start" marker)
  const lastSessionIdx = setupLogLines.value.map(l => l.step).lastIndexOf('Session Start');
  const currentSessionLines = lastSessionIdx >= 0 ? setupLogLines.value.slice(lastSessionIdx) : setupLogLines.value;
  const totalFiles = currentSessionLines.filter(l => l.step === 'File Uploaded').length;
  const failedUploads = currentSessionLines.filter(l => l.step === 'Upload Failed' || l.step === 'Upload Error').length;
  const hasIndexing = setupLogLines.value.some(l => l.step === 'Indexing Complete');
  const indexTokens = indexingStatus.value?.tokens || '0';
  const hasMeds = wizardCurrentMedications.value;
  const hasSummary = wizardPatientSummary.value;
  const summaryItems = [
    `Files uploaded: ${totalFiles}${failedUploads > 0 ? ` (${failedUploads} failed)` : ''}`,
    `Agent ready: ${wizardStage1Complete.value ? 'Yes' : 'No'}`,
    `KB indexed: ${hasIndexing ? 'Yes' : 'Pending'} (${indexTokens} tokens)`,
    `Current Medications: ${hasMeds ? 'Yes' : 'No'}`,
    `Patient Summary: ${hasSummary ? 'Yes' : 'No'}`
  ];
  for (const item of summaryItems) {
    doc.text(`  ${item}`, margin, y);
    y += 5;
  }
  y += 6;

  // Detailed log
  doc.setFontSize(11);
  doc.text('Detailed Log', margin, y);
  y += 6;
  doc.setFontSize(9);
  for (const line of setupLogLines.value) {
    if (y > 270) {
      doc.addPage();
      y = 20;
    }
    // Session Change divider — draw a horizontal rule and bold heading
    if (line.step === 'Session Change') {
      y += 3;
      doc.setDrawColor(100);
      doc.line(margin, y, pageWidth - margin, y);
      y += 6;
      doc.setFontSize(10);
      const timestamp = new Date(line.time).toLocaleTimeString();
      doc.text(`[${timestamp}] ${line.detail}`, margin, y);
      y += 8;
      doc.setFontSize(9);
      continue;
    }
    const statusIcon = line.ok ? '[OK]' : '[FAIL]';
    const timestamp = new Date(line.time).toLocaleTimeString();
    const text = `${statusIcon} [${timestamp}] ${line.step}: ${line.detail}`;
    const splitLines = doc.splitTextToSize(text, maxWidth);
    for (const sl of splitLines) {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      doc.text(sl, margin, y);
      y += 5;
    }
    y += 2;
  }

  const pdfBlob = doc.output('blob');
  await writeFileToFolder(localFolderHandle.value, 'maia-setup-log.pdf', pdfBlob);
  // Also persist JSON for history restoration across sessions
  await persistSetupLogJson();
};

/** Save current app state to maia-state.json in the local folder. */
const saveStateToLocalFolder = async () => {
  if (!localFolderHandle.value || !props.user?.userId) return;
  const state: MaiaState = {
    version: 1,
    userId: props.user.userId,
    displayName: props.user.displayName,
    updatedAt: new Date().toISOString(),
    files: wizardStage3Files.value.map(f => ({
      fileName: f.name,
      cloudStatus: f.inKnowledgeBase ? 'indexed' as const : 'pending' as const,
      bucketKey: f.bucketKey
    })),
    currentMedications: wizardCurrentMedications.value ? 'verified' : null,
    patientSummary: wizardPatientSummary.value ? 'verified' : null,
    savedChats: undefined,
    currentChat: undefined
  };
  await writeStateFile(localFolderHandle.value, state);
};

const stage3IndexingPoll = ref<ReturnType<typeof setInterval> | null>(null);
const stage3IndexingPending = ref(false);
const stage3IndexingStartedAt = ref<number | null>(null);
const stage3IndexingCompletedAt = ref<number | null>(null);
const stage3ElapsedTick = ref(0);
let stage3ElapsedTimer: ReturnType<typeof setInterval> | null = null;
const formatElapsed = (start: number | null, end?: number | null) => {
  if (!start) return '';
  void stage3ElapsedTick.value;
  const elapsedMs = (end || Date.now()) - start;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
};
const startStage3ElapsedTimer = () => {
  if (stage3ElapsedTimer) return;
  stage3ElapsedTimer = setInterval(() => {
    stage3ElapsedTick.value += 1;
  }, 1000);
};
const stopStage3ElapsedTimer = () => {
  if (stage3ElapsedTimer) {
    clearInterval(stage3ElapsedTimer);
    stage3ElapsedTimer = null;
  }
};

const handleStage3Index = async (overrideNames?: string[], fromRestore = false) => {
  const userId = props.user?.userId;
  if (!userId) return;
  if (stage3IndexingActive.value) return;
  stage3IndexingPending.value = true;
  if (fromRestore) {
    restoreIndexingActive.value = true;
  }
  try {
    const stage3Names = (overrideNames && overrideNames.length > 0)
      ? overrideNames
      : Array.from(new Set(wizardStage3Files.value.map(file => file.name)));
    if (stage3Names.length > 0) {
      const fetchWizardFiles = async () => {
        const filesResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(userId)}&source=wizard`, {
          credentials: 'include'
        });
        if (!filesResponse.ok) return [];
        const filesResult = await filesResponse.json();
        return Array.isArray(filesResult?.files) ? filesResult.files : [];
      };

      let files = await fetchWizardFiles();
      let byName = new Map<string, any>();
      for (const file of files) {
        const name = getFileNameFromEntry(file);
        if (!name || byName.has(name)) continue;
        byName.set(name, file);
      }

      let missingTargets: string[] = [];
      for (const name of stage3Names) {
        const file = byName.get(name);
        const bucketKey = file?.bucketKey;
        if (!bucketKey) {
          missingTargets.push(name);
        }
      }

      if (missingTargets.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 200));
        files = await fetchWizardFiles();
        byName = new Map();
        for (const file of files) {
          const name = getFileNameFromEntry(file);
          if (!name || byName.has(name)) continue;
          byName.set(name, file);
        }
        missingTargets = [];
        for (const name of stage3Names) {
          const file = byName.get(name);
          const bucketKey = file?.bucketKey;
          if (!bucketKey) {
            missingTargets.push(name);
          }
        }
      }

      if (missingTargets.length > 0) {
        throw new Error(`Missing bucket keys for: ${missingTargets.join(', ')}`);
      }

      const movedToKbBucketKeys: string[] = [];
      for (const name of stage3Names) {
        const file = byName.get(name);
        const bucketKey = file?.bucketKey;
        if (!bucketKey) {
          continue;
        }
        if (file?.inKnowledgeBase) {
          continue;
        }
        const toggleResponse = await fetch('/api/toggle-file-knowledge-base', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.user.userId,
            bucketKey,
            inKnowledgeBase: true
          })
        });
        if (!toggleResponse.ok) {
          const errorData = await toggleResponse.json().catch(() => ({}));
          throw new Error(errorData.message || `Failed to move ${name} to KB folder`);
        }
        movedToKbBucketKeys.push(bucketKey);
      }
      if (movedToKbBucketKeys.length > 0) {
        handleFilesArchived(movedToKbBucketKeys);
      }

      const verifyResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}`, {
        credentials: 'include'
      });
      if (verifyResponse.ok) {
        const verifyResult = await verifyResponse.json();
        const kbFiles = Array.isArray(verifyResult?.files)
          ? verifyResult.files.filter((file: { inKnowledgeBase?: boolean }) => !!file.inKnowledgeBase)
          : [];
        if (kbFiles.length === 0) {
          throw new Error('No KB files found after moving imports.');
        }
      }
    }

    const response = await fetch('/api/update-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.user.userId
      })
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to update knowledge base: ${response.status}`);
    }
    const result = await response.json();
    stage3LastImportedName.value = null;
    stage3IndexingStartedAt.value = Date.now();
    stage3IndexingCompletedAt.value = null;
    try {
      const k = wizardStage3IndexingStartedKey(props.user?.userId);
      if (k) sessionStorage.setItem(k, String(stage3IndexingStartedAt.value));
    } catch { /* ignore */ }
    indexingStatus.value = {
      active: true,
      phase: 'indexing',
      tokens: '0',
      filesIndexed: 0,
      progress: 0
    };
    startStage3ElapsedTimer();
    stage3IndexingPending.value = false;
    if (stage3IndexingPoll.value) {
      clearInterval(stage3IndexingPoll.value);
    }
    if (result?.jobId) {
      if (fromRestore) {
        const files = Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles : [];
        const hasInitialFile = files.some((item: { isInitial?: boolean }) => !!item?.isInitial);
        emit('rehydration-complete', { hasInitialFile });
      }
      let prevPollState = '';
      stage3IndexingPoll.value = setInterval(async () => {
        try {
          const statusResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user?.userId || '')}&source=wizard`, {
            credentials: 'include'
          });
          if (!statusResponse.ok) {
            throw new Error(`Indexing status error: ${statusResponse.status}`);
          }
          const statusResult = await statusResponse.json();
          const kbStatus = statusResult.kbIndexingStatus || {};
          const liveActive = !!statusResult?.kbIndexingActive;
          const backendDone = kbStatus.backendCompleted === true;
          // Fix: '0' is truthy in JS, so use Number() to properly fall through to kbTotalTokens
          const storedTokens = kbStatus.tokens;
          const liveTokens = statusResult?.kbTotalTokens ? String(statusResult.kbTotalTokens) : '0';
          const tokens = (Number(storedTokens) > 0) ? storedTokens : liveTokens;
          const elapsedPollMs = stage3IndexingStartedAt.value ? Date.now() - stage3IndexingStartedAt.value : 0;
          const elapsedPollMin = Math.floor(elapsedPollMs / 60000);
          const elapsedPollSec = Math.floor((elapsedPollMs % 60000) / 1000);
          // Only log to console when state changes
          const curPollState = `${backendDone}|${liveActive}|${tokens}|${kbStatus.phase || '?'}`;
          if (curPollState !== prevPollState) {
            console.log(`[KB-POLL] backendCompleted=${backendDone} liveActive=${liveActive} tokens=${tokens} phase=${kbStatus.phase || '?'} elapsed=${elapsedPollMin}m${elapsedPollSec}s`);
            prevPollState = curPollState;
          }
          if (indexingStatus.value) {
            indexingStatus.value.phase = kbStatus.phase || indexingStatus.value.phase;
            indexingStatus.value.tokens = tokens;
            indexingStatus.value.filesIndexed = kbStatus.filesIndexed || 0;
            indexingStatus.value.progress = kbStatus.progress || 0;
          }
          // Log progress every ~60s (every 6th poll at 10s interval)
          if (elapsedPollMs > 0 && Math.floor(elapsedPollMs / 60000) !== Math.floor((elapsedPollMs - 10000) / 60000)) {
            addSetupLogLine('Indexing Progress', `${elapsedPollMin}m elapsed — tokens=${tokens} files=${kbStatus.filesIndexed || 0} active=${liveActive} backendDone=${backendDone}`, true);
          }
          // Trust backendCompleted; also infer completion if DO API says not active and tokens > 0
          const inferredComplete = !liveActive && Number(tokens) > 0;
          // Also complete if DO API says not active for > 5 minutes (handles 0-token edge case)
          const timedOutInactive = !liveActive && !backendDone && elapsedPollMs > 5 * 60 * 1000;
          // Client-side safety net: if tokens > 0 for > 7 minutes, complete even if
          // liveActive is true (DO API job status can lag indefinitely behind actual completion)
          const tokenTimeoutComplete = !backendDone && !inferredComplete && Number(tokens) > 0 && elapsedPollMs > 7 * 60 * 1000;
          // Pure time-based fallback: if 20+ minutes elapsed with no completion signal at all,
          // the DO API is stuck. Complete to unblock the wizard (handles 0-token "no changes" case).
          const pureTimeoutComplete = !backendDone && !inferredComplete && !tokenTimeoutComplete && elapsedPollMs > 20 * 60 * 1000;
          const isCompleted = backendDone || inferredComplete || timedOutInactive || tokenTimeoutComplete || pureTimeoutComplete;
          const completionReason = backendDone ? 'backendCompleted' : inferredComplete ? 'inferredComplete' : timedOutInactive ? 'timedOutInactive' : tokenTimeoutComplete ? 'tokenTimeout' : pureTimeoutComplete ? 'pureTimeout' : '';
          if (isCompleted) {
            console.log(`[KB-POLL] ✅ Indexing complete: tokens=${tokens} files=${kbStatus.filesIndexed || 0} reason=${completionReason} elapsed=${elapsedPollMin}m${elapsedPollSec}s`);
            addSetupLogLine('Indexing Complete', `${kbStatus.filesIndexed || 0} file(s) indexed, ${tokens} tokens (${completionReason})`, true);
            if (stage3IndexingPoll.value) {
              clearInterval(stage3IndexingPoll.value);
              stage3IndexingPoll.value = null;
            }
            if (indexingStatus.value) {
              indexingStatus.value.active = false;
              indexingStatus.value.phase = 'complete';
            }
            stage3IndexingCompletedAt.value = Date.now();
            stopStage3ElapsedTimer();
            try {
              const k = wizardStage3IndexingStartedKey(props.user?.userId);
              if (k) sessionStorage.removeItem(k);
            } catch { /* ignore */ }
            await refreshWizardState();
            if (restoreIndexingActive.value) {
              restoreIndexingActive.value = false;
              showRestoreCompleteDialog.value = true;
            }
          }
        } catch (pollError) {
          console.warn('[KB-POLL] Error:', pollError);
        }
      }, 10000);
    }
  } catch (error) {
    console.warn('Failed to start indexing from wizard:', error);
    const message = error instanceof Error ? error.message : 'Failed to start indexing';
    alert(message);
    restoreIndexingActive.value = false;
    stage3IndexingPending.value = false;
  }
};



const handleFileSelect = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];

  if (!file) return;

  // Reconnect local folder NOW while we still have user-gesture context
  // (requestPermission requires an active gesture; it'll be lost after the first await)
  if (!localFolderHandle.value && props.user?.userId) {
    try {
      const result = await reconnectLocalFolderWithGesture(props.user.userId);
      if (result) {
        localFolderHandle.value = result.handle;
        localFolderName.value = result.folderName;
      }
    } catch (e) {
      // Not critical — file will still upload to cloud
    }
  }

  if (wizardUploadIntent.value === 'restore') {
    isUploadingFile.value = true;
    try {
      await uploadRestoreFile(file);
    } catch (error) {
      console.error('Error restoring file:', error);
      alert(`Error restoring file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      isUploadingFile.value = false;
      wizardUploadIntent.value = null;
      wizardRestoreTargetName.value = null;
    }
    return;
  }

  if (wizardUploadIntent.value === 'other') {
    stage3PendingUploadName.value = file.name;
    try {
      const pendingKey = props.user?.userId ? `wizardKbPendingFileName-${props.user.userId}` : 'wizardKbPendingFileName';
      localStorage.setItem(pendingKey, file.name);
      logWizardEvent('stage3_pending_file_set', { fileName: file.name });
    } catch (error) {
      // ignore storage errors
    }
  }

  isUploadingFile.value = true;

  try {
    // Detect file type
    const fileType = detectFileType(file.name, file.type);
    
    if (fileType === 'pdf') {
      await uploadPDFFile(file);
    } else if (fileType === 'text' || fileType === 'markdown') {
      await uploadTextFile(file);
    } else {
      throw new Error('Unsupported file type');
    }
  } catch (error) {
    console.error('Error uploading file:', error);
    alert(`Error uploading file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    stage3PendingUploadName.value = null;
  } finally {
    isUploadingFile.value = false;
    if (wizardUploadIntent.value) {
      handleWizardFileSelect();
    }
  }
};

const detectFileType = (fileName: string, mimeType: string): 'text' | 'pdf' | 'markdown' => {
  const ext = fileName.toLowerCase().split('.').pop();
  
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    return 'pdf';
  }
  
  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  
  return 'text';
};

// Helper to detect file type from stored file metadata
const detectFileTypeFromMetadata = (fileName: string, fileType?: string): 'text' | 'pdf' | 'markdown' => {
  // If fileType is already set and valid, use it
  if (fileType === 'pdf' || fileType === 'text' || fileType === 'markdown') {
    return fileType;
  }
  
  // Otherwise, detect from filename
  return detectFileType(fileName, '');
};

const detectAppleHealthFromBucket = async (bucketKey: string): Promise<boolean> => {
  if (!bucketKey) return false;
  try {
    const parseResponse = await fetch(`/api/files/parse-pdf-first-page/${encodeURIComponent(bucketKey)}`, {
      method: 'GET',
      credentials: 'include'
    });
    if (!parseResponse.ok) return false;
    const parseResult = await parseResponse.json();
    const pageText = String(parseResult?.firstPageText || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    return pageText.includes(appleExportFooterNormalized);
  } catch (error) {
    return false;
  }
};

const findRehydrationEntry = (fileName: string) => {
  if (!fileName) return null;
  const files = Array.isArray(props.rehydrationFiles) ? props.rehydrationFiles : [];
  return files.find(entry => {
    const entryName = entry?.fileName || (entry?.bucketKey ? entry.bucketKey.split('/').pop() : null);
    return entryName === fileName;
  }) || null;
};

const uploadRestoreFile = async (file: File) => {
  if (!props.user?.userId) return;
  const targetName = wizardRestoreTargetName.value || file.name;
  const entry = findRehydrationEntry(targetName);
  if (!entry) {
    throw new Error(`Restore entry not found for ${targetName}`);
  }
  if (file.name !== targetName) {
    throw new Error(`Please select the file named "${targetName}".`);
  }

  const formData = new FormData();
  formData.append('file', file);
  const uploadResponse = await fetch('/api/files/upload', {
    method: 'POST',
    credentials: 'include',
    body: formData
  });
  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json().catch(() => ({}));
    throw new Error(errorData.message || errorData.error || 'Failed to upload file');
  }
  const uploadResult = await uploadResponse.json();

  await fetch('/api/user-file-metadata', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      userId: props.user.userId,
      fileMetadata: {
        fileName: uploadResult.fileInfo.fileName,
        bucketKey: uploadResult.fileInfo.bucketKey,
        bucketPath: uploadResult.fileInfo.userFolder,
        fileSize: uploadResult.fileInfo.size,
        fileType: uploadResult.fileInfo.mimeType,
        uploadedAt: uploadResult.fileInfo.uploadedAt
      },
      updateInitialFile: !!entry?.isInitial
    })
  });

  emit('rehydration-file-removed', {
    fileName: targetName,
    bucketKey: entry?.bucketKey
  });
};

const uploadPDFFile = async (file: File) => {
  // Check file size
  const maxSize = 50 * 1024 * 1024; // 50MB
  if (file.size > maxSize) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 50MB.`);
  }

  // Parse PDF on server
  const formData = new FormData();
  formData.append('pdfFile', file);
  
  const parseResponse = await fetch('/api/files/parse-pdf', {
    method: 'POST',
    credentials: 'include',
    body: formData
  });

  if (!parseResponse.ok) {
    const errorData = await parseResponse.json();
    throw new Error(errorData.error || 'Failed to parse PDF');
  }

  const parseResult = await parseResponse.json();
  

  // Upload to bucket
  const uploadFormData = new FormData();
  uploadFormData.append('file', file);
  const uploadResponse = await fetch('/api/files/upload', {
    method: 'POST',
    credentials: 'include',
    body: uploadFormData
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    // Use detailed message if available (e.g., storage limit exceeded)
    throw new Error(errorData.message || errorData.error || 'Failed to upload file');
  }

  const uploadResult = await uploadResponse.json();

  // Update user document with file metadata
  if (props.user?.userId) {
    try {
      const isAppleHealth = await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey);
      await fetch('/api/user-file-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.user.userId,
          fileMetadata: {
            fileName: uploadResult.fileInfo.fileName,
            bucketKey: uploadResult.fileInfo.bucketKey,
            bucketPath: uploadResult.fileInfo.userFolder,
            fileSize: uploadResult.fileInfo.size,
            fileType: 'pdf',
            uploadedAt: uploadResult.fileInfo.uploadedAt,
            isAppleHealth: isAppleHealth
          },
          updateInitialFile: false
        })
      });
      await refreshWizardState();

      // Copy file to local MAIA folder so it's available for offline restore
      // (localFolderHandle was reconnected at file-select time while gesture was active)
      if (localFolderHandle.value) {
        try {
          await writeFileToFolder(localFolderHandle.value, file.name, file);
          // Update maia-state.json to include the new file
          const state = await readStateFile(localFolderHandle.value);
          if (state) {
            const stateFiles = state.files || [];
            const existing = stateFiles.find((f: any) => f.fileName === file.name);
            if (!existing) {
              stateFiles.push({
                fileName: file.name,
                size: file.size,
                cloudStatus: 'uploaded' as const,
                bucketKey: uploadResult.fileInfo.bucketKey
              });
              state.files = stateFiles;
              await writeStateFile(localFolderHandle.value, state);
            }
          }
        } catch (folderErr) {
          console.warn('[localFolder] Failed to copy paperclip file to local folder:', folderErr);
        }
      }
    } catch (error) {
      console.warn('Failed to save file metadata to user document:', error);
    }
  }

  // Create uploaded file object
  const uploadedFile: UploadedFile = {
    id: `file-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    name: file.name,
    size: file.size,
    type: 'pdf',
    content: parseResult.text,
    originalFile: file,
    bucketKey: uploadResult.fileInfo.bucketKey,
    bucketPath: uploadResult.fileInfo.userFolder,
    fileUrl: uploadResult.fileInfo.fileUrl,
    uploadedAt: new Date()
  };

  if (wizardUploadIntent.value === 'other') {
    const importedName = uploadResult.fileInfo.fileName || file.name;
    stage3PendingUploadName.value = null;
    stage3LastImportedName.value = importedName;
    uploadedFiles.value.push(uploadedFile);
    // no-op
  } else if (!wizardUploadIntent.value) {
    uploadedFiles.value.push(uploadedFile);
  }
};

const uploadTextFile = async (file: File) => {
  // Check file size
  const maxSize = 50 * 1024 * 1024; // 50MB
  if (file.size > maxSize) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 50MB.`);
  }

  // Read text content
  const text = await readFileAsText(file);
  
  // Upload to bucket
  const uploadFormData = new FormData();
  uploadFormData.append('file', file);

  const uploadResponse = await fetch('/api/files/upload', {
    method: 'POST',
    credentials: 'include',
    body: uploadFormData
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    throw new Error(errorData.message || errorData.error || 'Failed to upload file');
  }

  const uploadResult = await uploadResponse.json();

  // Update user document with file metadata
  if (props.user?.userId) {
    try {
      await fetch('/api/user-file-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.user.userId,
          fileMetadata: {
            fileName: uploadResult.fileInfo.fileName,
            bucketKey: uploadResult.fileInfo.bucketKey,
            bucketPath: uploadResult.fileInfo.userFolder,
            fileSize: uploadResult.fileInfo.size,
            fileType: file.name.endsWith('.md') ? 'markdown' : 'text',
            uploadedAt: uploadResult.fileInfo.uploadedAt
          }
        })
      });
      await refreshWizardState();
    } catch (error) {
      console.warn('Failed to save file metadata to user document:', error);
    }
  }

  // Create uploaded file object
  const uploadedFile: UploadedFile = {
    id: `file-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    name: file.name,
    size: file.size,
    type: file.name.endsWith('.md') ? 'markdown' : 'text',
    content: text,
    originalFile: file,
    bucketKey: uploadResult.fileInfo.bucketKey,
    bucketPath: uploadResult.fileInfo.userFolder,
    fileUrl: uploadResult.fileInfo.fileUrl,
    uploadedAt: new Date()
  };

  uploadedFiles.value.push(uploadedFile);
  if (wizardUploadIntent.value === 'other') {
    const importedName = uploadResult.fileInfo.fileName || file.name;
    stage3PendingUploadName.value = null;
    stage3LastImportedName.value = importedName;
    // no-op
  }
};

const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
};

const viewFile = (file: UploadedFile, page?: number) => {
  viewingFile.value = file;
  
  // Determine file type - use detectFileTypeFromMetadata if type is not set or invalid
  let fileType = file.type;
  if (!fileType || (fileType !== 'pdf' && fileType !== 'text' && fileType !== 'markdown')) {
    fileType = detectFileTypeFromMetadata(file.name || '', file.type);
  }
  
  // Open appropriate viewer based on detected type
  if (fileType === 'pdf') {
    pdfInitialPage.value = page;
    showPdfViewer.value = true;
    showTextViewer.value = false;
  } else {
    // Default to text viewer for text, markdown, and unknown types
    showTextViewer.value = true;
    showPdfViewer.value = false;
  }
};

// Process markdown content to convert page references to clickable links
// Strategy: Find "page"/"Page" + number in markdown, insert HTML links before parsing
const processPageReferences = (content: string): string => {
  const pdfFiles = uploadedFiles.value.filter(f => f.type === 'pdf');
  
  // Find all occurrences of "page" or "Page" followed by a number
  // Pattern matches: "Page 24", "page 24", "Page: 24", "page:24", "Page:** 24", "**Page:** 27", etc.
  // IMPORTANT: Only match when "page" is directly followed by a number (with optional whitespace/punctuation/markdown)
  // Do NOT match "page" followed by other words and then a number later
  // The pattern allows: whitespace (\s), colons (:), asterisks (* for markdown), dashes (-), but NOT other letters/words
  // Note: - is at the end of character class to avoid being interpreted as a range
  const pageReferencePattern = /(Page|page)[\s:*-]*(\d+)/gi;
  const pageReferences: Array<{ fullMatch: string; pageWord: string; pageNum: number; index: number }> = [];
  
  let match;
  pageReferencePattern.lastIndex = 0;
  while ((match = pageReferencePattern.exec(content)) !== null) {
    pageReferences.push({
      fullMatch: match[0],
      pageWord: match[1],
      pageNum: parseInt(match[2], 10),
      index: match.index
    });
  }
  
  if (pageReferences.length === 0) {
    return markdownParser.render(content);
  }
  
  // Find PDF filenames in the content
  // Look for filenames with various labels: File:, Filename:, Document:, or standalone
  // Also handle markdown formatting like **Filename:** or **File:**
  const pdfFilenamePatterns = [
    /\*\*(?:File|Filename|Document|Source):\*\*\s*([A-Za-z0-9_\-\.]+\.(?:PDF|pdf))/gi, // Markdown bold with label
    /(?:File|Filename|Document|Source):\s*([A-Za-z0-9_\-\.]+\.(?:PDF|pdf))/gi, // With label (no markdown)
    /([A-Za-z0-9_\-\.]+\.(?:PDF|pdf))/gi // Standalone
  ];
  const pdfFilenames: Array<{ filename: string; index: number; label?: string }> = [];
  
  // First, find filenames with labels (including markdown)
  for (const pattern of pdfFilenamePatterns) {
    pattern.lastIndex = 0;
    let filenameMatch: RegExpExecArray | null;
    while ((filenameMatch = pattern.exec(content)) !== null) {
      const filename = filenameMatch[1] || filenameMatch[0];
      // Avoid duplicates
      if (!pdfFilenames.some(f => f.filename === filename && f.index === filenameMatch!.index)) {
        pdfFilenames.push({ 
          filename: filename, 
          index: filenameMatch.index,
          label: filenameMatch[0].includes(':') ? filenameMatch[0].split(':')[0].replace(/\*/g, '') : undefined
        });
      }
    }
  }
  
  // Sort by index
  pdfFilenames.sort((a, b) => a.index - b.index);
  
  // Process page references in reverse order to preserve indices
  let processedContent = content;
  
  for (let i = pageReferences.length - 1; i >= 0; i--) {
    const { fullMatch, pageNum, index } = pageReferences[i];
    
    // Skip if this text is already inside an HTML tag (to avoid double-linking)
    const beforeMatch = processedContent.substring(Math.max(0, index - 50), index);
    if (beforeMatch.includes('<a ') && !beforeMatch.includes('</a>')) {
      continue;
    }
    
    // Find the closest PDF filename before or after this page reference
    // If there's only one filename in the context (within 200 chars before/after), use it regardless of label
    let matchedFilename: string | null = null;
    let matchedFile: UploadedFile | null = null;
    
    const contextStart = Math.max(0, index - 200);
    const contextEnd = Math.min(content.length, index + fullMatch.length + 200);
    
    // Find all filenames in the context
    const filenamesInContext = pdfFilenames.filter(f => 
      f.index >= contextStart && f.index <= contextEnd
    );
    
    // If there's exactly one filename in context, use it (regardless of label or position)
    if (filenamesInContext.length === 1) {
      matchedFilename = filenamesInContext[0].filename;
      matchedFile = pdfFiles.find(f => {
        const nameUpper = f.name?.toUpperCase();
        const filenameUpper = matchedFilename!.toUpperCase();
        return nameUpper === filenameUpper || 
               nameUpper.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
               filenameUpper.includes(nameUpper.replace(/\.(PDF|pdf)$/, ''));
      }) || null;
      
      // If not found in uploadedFiles, check availableUserFiles (if already loaded)
      if (!matchedFile && matchedFilename && availableUserFiles.value.length > 0) {
        const matchedUserFile = availableUserFiles.value.find(f => {
          const fileUpper = f.fileName?.toUpperCase();
          const filenameUpper = matchedFilename!.toUpperCase();
          return fileUpper === filenameUpper || 
                 fileUpper?.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
                 filenameUpper.includes(fileUpper?.replace(/\.(PDF|pdf)$/, '') || '');
        });
        
        if (matchedUserFile) {
          // Create a pseudo-file object for matching
          matchedFile = {
            name: matchedUserFile.fileName,
            bucketKey: matchedUserFile.bucketKey
          } as UploadedFile;
        }
      }
    } else {
      // Multiple filenames or none - use the closest one before the page reference
      const filenameBefore = pdfFilenames.filter(f => f.index < index);
      if (filenameBefore.length > 0) {
        matchedFilename = filenameBefore[filenameBefore.length - 1].filename;
        matchedFile = pdfFiles.find(f => {
          const nameUpper = f.name?.toUpperCase();
          const filenameUpper = matchedFilename!.toUpperCase();
          return nameUpper === filenameUpper || 
                 nameUpper.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
                 filenameUpper.includes(nameUpper.replace(/\.(PDF|pdf)$/, ''));
        }) || null;
      }
    }
    
    // Create the HTML link (markdown allows raw HTML)
    let linkHtml: string;
    if (matchedFile && matchedFilename) {
      const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      linkHtml = `<a href="#" class="page-link" data-filename="${matchedFilename}" data-page="${pageNum}" data-bucket-key="${matchedFile.bucketKey || ''}">${escapedText}</a>`;
    } else if (pdfFiles.length === 1) {
      const singleFile = pdfFiles[0];
      const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      linkHtml = `<a href="#" class="page-link" data-filename="${singleFile.name}" data-page="${pageNum}" data-bucket-key="${singleFile.bucketKey || ''}">${escapedText}</a>`;
    } else {
      // Check if filename found in bubble matches a file in availableUserFiles
      let matchedUserFile: { fileName: string; bucketKey: string } | null = null;
      if (matchedFilename) {
        matchedUserFile = availableUserFiles.value.find(f => {
          const fileUpper = f.fileName?.toUpperCase();
          const filenameUpper = matchedFilename!.toUpperCase();
          return fileUpper === filenameUpper || 
                 fileUpper?.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
                 filenameUpper.includes(fileUpper?.replace(/\.(PDF|pdf)$/, '') || '');
        }) || null;
      }
      
      if (matchedUserFile && matchedFilename) {
        // Found a match in user files - create direct link
        const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        linkHtml = `<a href="#" class="page-link" data-filename="${matchedFilename}" data-page="${pageNum}" data-bucket-key="${matchedUserFile.bucketKey}">${escapedText}</a>`;
      } else if (matchedFilename) {
        // We found a filename in the AI response but haven't matched it yet
        // Store the filename in the link so it can be matched when files are loaded on click
        const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        linkHtml = `<a href="#" class="page-link page-link-chooser" data-filename="${matchedFilename}" data-page="${pageNum}">${escapedText}</a>`;
      } else {
        // No filename found - create chooser link without filename
        const escapedText = fullMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        linkHtml = `<a href="#" class="page-link page-link-chooser" data-page="${pageNum}">${escapedText}</a>`;
      }
    }
    
    // Replace the text in the markdown content
    const before = processedContent.substring(0, index);
    const after = processedContent.substring(index + fullMatch.length);
    processedContent = before + linkHtml + after;
  }
  
  return markdownParser.render(processedContent);
};

// Processed message HTML (reactive to file lists so Saved Files links become direct after preload).
// During streaming, skip heavy processPageReferences for the growing message so the UI stays responsive.
const messageDisplayHtml = computed(() => {
  // Depend on file lists so we re-run when Saved Files load (processPageReferences uses them)
  void availableUserFiles.value;
  void uploadedFiles.value;
  const list = messages.value;
  const n = list.length;
  const streaming = isStreaming.value;
  if (streaming && n > 0) {
    return list.map((msg, idx) =>
      idx === n - 1 ? markdownParser.render(msg.content) : processPageReferences(msg.content)
    );
  }
  return list.map(msg => processPageReferences(msg.content));
});

// Handle click on page link
const handlePageLinkClick = async (event: Event) => {
  event.preventDefault();
  const target = event.target as HTMLElement;
  const link = target.closest('.page-link') as HTMLElement;
  
  if (!link) return;
  
  const pageNum = link.getAttribute('data-page');
  if (!pageNum) return;
  
  const pageNumber = parseInt(pageNum, 10);
  
  // Check if this is a chooser link (no filename specified)
  if (link.classList.contains('page-link-chooser')) {
    const pdfFiles = uploadedFiles.value.filter(f => f.type === 'pdf');
    
    // If we have PDFs in the current chat, use them
    if (pdfFiles.length > 1) {
      // Multiple PDFs in chat, show chooser with those
      pendingPageLink.value = { pageNum: pageNumber };
      showDocumentChooser.value = true;
      return;
    } else if (pdfFiles.length === 1) {
      // Single PDF in chat, use it
      viewFile(pdfFiles[0], pageNumber);
      return;
    }
    
    // No PDFs in current chat - check if filename in link matches a user file
    const filename = link.getAttribute('data-filename');
    if (filename) {
      // Lazy-load user files if not already loaded
      if (availableUserFiles.value.length === 0 && !loadingUserFiles.value) {
        // Load files first, then try to match after loading completes
        pendingPageLink.value = { pageNum: pageNumber };
        await loadUserFilesForChooser(false);
        
        // After loading, try to match the filename
        const matchedUserFile = availableUserFiles.value.find(f => {
          const fileUpper = f.fileName?.toUpperCase();
          const filenameUpper = filename.toUpperCase();
          return fileUpper === filenameUpper || 
                 fileUpper?.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
                 filenameUpper.includes(fileUpper?.replace(/\.(PDF|pdf)$/, '') || '');
        });
        
        if (matchedUserFile) {
          const userFile: UploadedFile = {
            id: `user-file-${matchedUserFile.bucketKey}`,
            name: matchedUserFile.fileName,
            size: 0,
            type: detectFileTypeFromMetadata(matchedUserFile.fileName, matchedUserFile.fileType),
            content: '',
            originalFile: null as any,
            bucketKey: matchedUserFile.bucketKey,
            uploadedAt: new Date()
          };
          viewFile(userFile, pageNumber);
          pendingPageLink.value = null;
          return;
        }
        
        // No match found after loading - show chooser
        showDocumentChooser.value = true;
        return;
      }
      
      // Check availableUserFiles if already loaded
      const matchedUserFile = availableUserFiles.value.find(f => {
        const fileUpper = f.fileName?.toUpperCase();
        const filenameUpper = filename.toUpperCase();
        return fileUpper === filenameUpper || 
               fileUpper?.includes(filenameUpper.replace(/\.(PDF|pdf)$/, '')) ||
               filenameUpper.includes(fileUpper?.replace(/\.(PDF|pdf)$/, '') || '');
      });
      
      if (matchedUserFile) {
        const userFile: UploadedFile = {
          id: `user-file-${matchedUserFile.bucketKey}`,
          name: matchedUserFile.fileName,
          size: 0,
          type: detectFileTypeFromMetadata(matchedUserFile.fileName, matchedUserFile.fileType),
          content: '',
          originalFile: null as any,
          bucketKey: matchedUserFile.bucketKey,
          uploadedAt: new Date()
        };
        viewFile(userFile, pageNumber);
        return;
      }
    }
    
    // No match found - fetch user files and show chooser
    pendingPageLink.value = { pageNum: pageNumber };
    loadUserFilesForChooser();
    return;
  }
  
  // Regular link with filename
  const filename = link.getAttribute('data-filename');
  const bucketKey = link.getAttribute('data-bucket-key');
  
  if (!filename) return;
  
  // Find the file in uploadedFiles (current chat)
  const file = uploadedFiles.value.find(f => 
    f.name?.toUpperCase() === filename.toUpperCase() ||
    (bucketKey && f.bucketKey === bucketKey) ||
    f.name?.toUpperCase().includes(filename.toUpperCase().replace(/\.(PDF|pdf)$/, ''))
  );
  
  if (file) {
    viewFile(file, pageNumber);
    return;
  }
  
  // File not in uploadedFiles - check if it's a user file with bucketKey
  if (bucketKey && filename) {
    // Create a user file object and view it
    const userFile: UploadedFile = {
      id: `user-file-${bucketKey}`,
      name: filename,
      size: 0,
      type: detectFileTypeFromMetadata(filename),
      content: '',
      originalFile: null as any,
      bucketKey: bucketKey,
      uploadedAt: new Date()
    };
    viewFile(userFile, pageNumber);
  }
};

// Load user files for the document chooser (lazy-loaded when needed)
const loadUserFilesForChooser = async (showChooser = true) => {
  if (!props.user?.userId) {
    if (showChooser) {
      showDocumentChooser.value = true; // Show chooser anyway (might be empty)
    }
    return;
  }
  
  // Skip loading if already loading
  if (loadingUserFiles.value) {
    if (showChooser) {
      showDocumentChooser.value = true;
    }
    return;
  }
  
  loadingUserFiles.value = true;
  try {
    const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.user.userId)}`, {
      credentials: 'include'
    });
    
    if (response.ok) {
      const result = await response.json();
      // Include PDF, text, and markdown files (not just PDFs)
      const userFiles = (result.files || [])
        .filter((f: any) => {
          const fileName = f.fileName?.toLowerCase() || '';
          const fileType = f.fileType?.toLowerCase();
          return fileType === 'pdf' || fileType === 'text' || fileType === 'markdown' ||
                 fileName.endsWith('.pdf') || fileName.endsWith('.txt') || 
                 fileName.endsWith('.md') || fileName.endsWith('.markdown');
        })
        .map((f: any) => ({
          fileName: f.fileName,
          bucketKey: f.bucketKey,
          fileType: f.fileType || detectFileTypeFromMetadata(f.fileName)
        }));
      
      availableUserFiles.value = userFiles;
    } else {
      availableUserFiles.value = [];
    }
  } catch (error) {
    console.error('Error loading user files:', error);
    availableUserFiles.value = [];
  } finally {
    loadingUserFiles.value = false;
    if (showChooser) {
      showDocumentChooser.value = true;
    }
  }
};

// Close document chooser and clear state
const closeDocumentChooser = () => {
  showDocumentChooser.value = false;
  pendingPageLink.value = null;
  availableUserFiles.value = [];
};

// Handle document selection from chooser
const handleDocumentSelected = (file: UploadedFile | { fileName: string; bucketKey: string }) => {
  if (!pendingPageLink.value) return;
  
  // Check if it's a user file (from account) or uploaded file (from chat)
  // User files have fileName property but no id property
  if ('fileName' in file && 'bucketKey' in file && !('id' in file)) {
    // User file from account - create a minimal UploadedFile-like object
    const fileType = 'fileType' in file ? (file.fileType as string | undefined) : undefined;
    const userFile: UploadedFile = {
      id: `user-file-${file.bucketKey}`,
      name: file.fileName,
      size: 0,
      type: detectFileTypeFromMetadata(file.fileName, fileType),
      content: '',
      originalFile: null as any,
      bucketKey: file.bucketKey,
      uploadedAt: new Date()
    };
    viewFile(userFile, pendingPageLink.value.pageNum);
  } else {
    // Regular uploaded file from chat
    viewFile(file as UploadedFile, pendingPageLink.value.pageNum);
  }
  
  pendingPageLink.value = null;
  showDocumentChooser.value = false;
};

const removeFile = (file: UploadedFile) => {
  const index = uploadedFiles.value.findIndex(f => f.id === file.id);
  if (index !== -1) {
    uploadedFiles.value.splice(index, 1);
  }
};

const markdownParser = new MarkdownIt({
  html: true, // Allow HTML so we can render clickable page links
  linkify: true,
  breaks: true,
  typographer: true
});

const pdfMargin = { top: 48, right: 48, bottom: 48, left: 48 };
const bubbleWidthRatio = 0.9;
const bubblePaddingX = 14;
const bubblePaddingY = 12;
const authorChipHeight = 16;
const authorChipPaddingX = 6;
const authorChipSpacing = 8;
const metaChipHeight = 14;
const metaChipPaddingX = 5;
const metaChipSpacing = 6;
const bubbleSpacing = 24;
const baseFontSize = 8;
const headingFontSizes: Record<number, number> = { 1: 14, 2: 12, 3: 10, 4: 9 };
const lineHeight = 11;
const bulletIndent = 14;
const fileChipHeight = 24;
const fileChipPaddingX = 12;
const fileChipSpacing = 10;
const fileIconSize = 12;
const eyeIconSize = 12;

interface MarkedToken {
  text?: string;
  bold?: boolean;
  newline?: boolean;
}

interface MessageBlock {
  type: 'paragraph' | 'heading' | 'bullet';
  level?: number;
  text: string;
}

type SegmentItemKind = 'padding' | 'block' | 'gap' | 'meta' | 'actions';

interface MarkedSegment {
  text: string;
  bold: boolean;
}

interface MarkedLine {
  segments: MarkedSegment[];
  bullet: boolean;
}

interface BlockSegmentData {
  fontSize: number;
  lineHeight: number;
  indent: number;
  line: MarkedLine;
}

interface SegmentItem {
  kind: SegmentItemKind;
  height: number;
  blockData?: BlockSegmentData;
  chips?: string[];
}

interface RenderState {
  cursorY: number;
  pageWidth: number;
  pageHeight: number;
}

interface MessageMeasurement {
  bubbleHeight: number;
  contentHeight: number;
  metaHeight: number;
  totalHeight: number;
  items: SegmentItem[];
  metaChips: string[];
}

const inlineToMarkedText = (inline: any): string => {
  let result = '';
  let bold = false;

  inline?.children?.forEach((child: any) => {
    switch (child.type) {
      case 'strong_open':
        bold = true;
        break;
      case 'strong_close':
        bold = false;
        break;
      case 'text':
      case 'code_inline':
        if (child.content) {
          result += bold ? `**${child.content}**` : child.content;
        }
        break;
      case 'softbreak':
      case 'hardbreak':
        result += '\n';
        break;
      default:
        break;
    }
  });

  return result.trim();
};

const tokenizeMarkedText = (text: string): MarkedToken[] => {
  const tokens: MarkedToken[] = [];
  let buffer = '';
  let bold = false;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith('**', i)) {
      if (buffer) {
        tokens.push({ text: buffer, bold });
        buffer = '';
      }
      bold = !bold;
      i += 2;
      continue;
    }

    if (text[i] === '\n') {
      if (buffer) {
        tokens.push({ text: buffer, bold });
        buffer = '';
      }
      tokens.push({ newline: true });
      i += 1;
      continue;
    }

    buffer += text[i];
    i += 1;
  }

  if (buffer) {
    tokens.push({ text: buffer, bold });
  }

  return tokens;
};

const buildMarkedLines = (
  doc: jsPDF,
  text: string,
  fontSize: number,
  maxWidth: number
): MarkedLine[] => {
  const tokens = tokenizeMarkedText(text);
  const lines: MarkedLine[] = [];
  let currentSegments: MarkedSegment[] = [];
  let cursorWidth = 0;

  const pushLine = () => {
    const segments = [...currentSegments];

    while (segments.length > 0 && segments[0].text.trim().length === 0) {
      segments.shift();
    }

    while (segments.length > 0 && segments[segments.length - 1].text.trim().length === 0) {
      segments.pop();
    }

    if (segments.length === 0) {
      lines.push({ segments: [{ text: '', bold: false }], bullet: false });
    } else {
      lines.push({ segments, bullet: false });
    }

    currentSegments = [];
    cursorWidth = 0;
  };

  tokens.forEach(token => {
    if (token.newline) {
      pushLine();
      return;
    }

    if (!token.text) return;

    const parts = token.text.split(/(\s+)/).filter(Boolean);

    parts.forEach(part => {
      doc.setFont('helvetica', token.bold ? 'bold' : 'normal');
      doc.setFontSize(fontSize);
      const isWhitespace = /^\s+$/.test(part);
      const width = doc.getTextWidth(part);

      if (isWhitespace) {
        if (cursorWidth + width > maxWidth && currentSegments.length > 0) {
          pushLine();
        } else {
          currentSegments.push({ text: part, bold: token.bold ?? false });
          cursorWidth += width;
        }
        return;
      }

      if (width > maxWidth) {
        const broken = doc.splitTextToSize(part, maxWidth);
        broken.forEach((piece: string, index: number) => {
          const pieceWidth = doc.getTextWidth(piece);
          if (cursorWidth > 0 && cursorWidth + pieceWidth > maxWidth) {
            pushLine();
          }
          currentSegments.push({ text: piece, bold: token.bold ?? false });
          cursorWidth += pieceWidth;
          if (index < broken.length - 1) {
            pushLine();
          }
        });
        return;
      }

      if (cursorWidth > 0 && cursorWidth + width > maxWidth) {
        pushLine();
      }

      currentSegments.push({ text: part, bold: token.bold ?? false });
      cursorWidth += width;
    });
  });

  if (currentSegments.length > 0) {
    pushLine();
  }

  if (lines.length === 0) {
    lines.push({ segments: [{ text: '', bold: false }], bullet: false });
  }

  return lines;
};

const normalizeText = (text: string): string => (
   text
     .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
     .replace(/[\u00AD\u2010\u2011]/g, '-')
     .replace(/[\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
     .replace(/[\u2012-\u2015\u2212]/g, '-')
     .replace(/\u00A0/g, ' ')
     .replace(/\s+\n/g, '\n')
     .replace(/\n\s+/g, '\n')
     .replace(/\s+/g, ' ')
     .trim()
 );

const ensureRoom = (doc: jsPDF, state: RenderState, requiredHeight: number) => {
  if (state.cursorY + requiredHeight > state.pageHeight - pdfMargin.bottom) {
    doc.addPage();
    state.cursorY = pdfMargin.top;
  }
};

// @ts-ignore
const renderMarkedText = (
  doc: jsPDF,
  text: string,
  startX: number,
  startY: number,
  width: number,
  options: { fontSize: number; lineSpacing: number }
) => {
  const tokens = tokenizeMarkedText(text);
  const lineSpacing = options.lineSpacing;
  let cursorX = startX;
  let cursorY = startY;

  tokens.forEach(token => {
    if (token.newline) {
      cursorY += lineSpacing;
      cursorX = startX;
      return;
    }

    if (!token.text) return;

    const parts = token.text.split(/(\s+)/).filter(Boolean);

    parts.forEach(part => {
      const isWhitespace = /^\s+$/.test(part);
      doc.setFont('helvetica', token.bold ? 'bold' : 'normal');
      doc.setFontSize(options.fontSize);

      if (isWhitespace) {
        cursorX += doc.getTextWidth(part);
        return;
      }

      const broken = doc.splitTextToSize(part, width);
      broken.forEach((piece: string, index: number) => {
        const pieceWidth = doc.getTextWidth(piece);
        if (cursorX !== startX && cursorX - startX + pieceWidth > width) {
          cursorY += lineSpacing;
          cursorX = startX;
        }

        doc.text(piece, cursorX, cursorY, { baseline: 'top' });
        cursorX += pieceWidth;

        if (index < broken.length - 1) {
          cursorY += lineSpacing;
          cursorX = startX;
        }
      });
    });
  });

  return cursorY - startY + lineSpacing;
};

const getBlocksFromMessage = (message: Message): MessageBlock[] => {
  if (!message.content) {
    return [{ type: 'paragraph', text: '' }];
  }

  const tokens = markdownParser.parse(message.content, {});
  const blocks: MessageBlock[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.type === 'table_open') {
      const tableRows: string[][] = [];
      let j = i + 1;
      let currentRow: string[] = [];

      for (; j < tokens.length; j += 1) {
        const tableToken = tokens[j];

        if (tableToken.type === 'tr_open') {
          currentRow = [];
        }

        if (tableToken.type === 'tr_close') {
          if (currentRow.length > 0) {
            tableRows.push(currentRow);
          }
          currentRow = [];
        }

        if (tableToken.type === 'th_open' || tableToken.type === 'td_open') {
          const inlineCell = tokens[j + 1];
          if (inlineCell?.type === 'inline') {
            currentRow.push(inlineToMarkedText(inlineCell));
          } else {
            currentRow.push('');
          }
        }

        if (tableToken.type === 'table_close') {
          break;
        }
      }

      if (tableRows.length > 0) {
        tableRows.forEach((row, index) => {
          const text = row.join(' | ');
          const formatted = index === 0 ? `**${text}**` : text;
          blocks.push({ type: 'paragraph', text: formatted });
        });
      }

      i = j;
      continue;
    }

    if (token.type !== 'inline') continue;

    const prevToken = tokens[i - 1];
    if (!prevToken) continue;

    if (prevToken.type === 'heading_open') {
      const level = parseInt(prevToken.tag.replace('h', ''), 10) || 3;
      blocks.push({ type: 'heading', level, text: inlineToMarkedText(token) });
      continue;
    }

    if (prevToken.type === 'paragraph_open') {
      const beforeParagraph = tokens[i - 2];
      if (beforeParagraph && beforeParagraph.type === 'list_item_open') {
        blocks.push({ type: 'bullet', text: inlineToMarkedText(token) });
      } else {
        blocks.push({ type: 'paragraph', text: inlineToMarkedText(token) });
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph', text: message.content });
  }

  return blocks;
};

const drawDocumentIcon = (doc: jsPDF, x: number, y: number, width: number, height: number) => {
   doc.setDrawColor(25, 118, 210);
   doc.setFillColor(255, 255, 255);
   doc.roundedRect(x, y, width, height, 2, 2, 'FD');
   doc.setFillColor(227, 242, 253);
   doc.setFillColor(187, 222, 251);
   doc.rect(x + width * 0.15, y + height * 0.65, width * 0.7, height * 0.15, 'F');
 };
 
 const drawEyeIcon = (doc: jsPDF, x: number, y: number, width: number, height: number) => {
   const centerX = x + width / 2;
   const centerY = y + height / 2;
   doc.setDrawColor(79, 195, 247);
   doc.setFillColor(255, 255, 255);
   doc.ellipse(centerX, centerY, width / 2, height / 2, 'FD');
   doc.setFillColor(79, 195, 247);
   doc.circle(centerX, centerY, Math.min(width, height) / 4, 'F');
 };

const renderFileChips = (doc: jsPDF, files: UploadedFile[], state: RenderState) => {
  if (!files.length) {
    return;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(baseFontSize + 2);

  if (state.cursorY + lineHeight > state.pageHeight - pdfMargin.bottom) {
    doc.addPage();
    state.cursorY = pdfMargin.top;
  }

  doc.setTextColor(62, 62, 62);
  doc.text('Attached Files', pdfMargin.left, state.cursorY);
  state.cursorY += lineHeight;

  let rowY = state.cursorY;
  let currentX = pdfMargin.left;

  files.forEach(file => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(baseFontSize + 1);
    const textWidth = doc.getTextWidth(file.name);
    const chipWidth = fileChipPaddingX * 2 + fileIconSize + 6 + textWidth + 8 + eyeIconSize;

    if (currentX + chipWidth > state.pageWidth - pdfMargin.right) {
      currentX = pdfMargin.left;
      rowY += fileChipHeight + fileChipSpacing;
    }

    if (rowY + fileChipHeight > state.pageHeight - pdfMargin.bottom) {
      doc.addPage();
      state.cursorY = pdfMargin.top;
      rowY = state.cursorY;
      currentX = pdfMargin.left;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(baseFontSize + 2);
      doc.text('Attached Files (cont.)', pdfMargin.left, rowY);
      rowY += lineHeight;
    }

    doc.setDrawColor(187, 222, 251);
    doc.setFillColor(227, 242, 253);
    doc.roundedRect(currentX, rowY, chipWidth, fileChipHeight, 6, 6, 'FD');

    const iconY = rowY + (fileChipHeight - fileIconSize) / 2;
    drawDocumentIcon(doc, currentX + fileChipPaddingX / 2, iconY, fileIconSize, fileIconSize);

    doc.setTextColor(25, 118, 210);
    const textX = currentX + fileChipPaddingX / 2 + fileIconSize + 6;
    const textY = rowY + fileChipHeight / 2 + 3;
    doc.text(file.name, textX, textY, { baseline: 'middle' });

    const eyeX = currentX + chipWidth - eyeIconSize - fileChipPaddingX / 2;
    const eyeY = rowY + (fileChipHeight - eyeIconSize) / 2;
    drawEyeIcon(doc, eyeX, eyeY, eyeIconSize, eyeIconSize);

    currentX += chipWidth + fileChipSpacing;
  });

  state.cursorY = rowY + fileChipHeight + bubbleSpacing;
  doc.setTextColor(32, 32, 32);
};

const measureMessage = (doc: jsPDF, message: Message, bubbleWidth: number): MessageMeasurement => {
  const textWidth = bubbleWidth - bubblePaddingX * 2;
  const blocks = getBlocksFromMessage(message);
  const items: SegmentItem[] = [];

  let contentHeight = 0;

  const addItem = (item: SegmentItem) => {
    items.push(item);
    contentHeight += item.height;
  };

  addItem({ kind: 'padding', height: bubblePaddingY });

  blocks.forEach(block => {
    const fontSize = block.type === 'heading' ? headingFontSizes[block.level || 3] || baseFontSize : baseFontSize;
    const blockLineHeight = block.type === 'heading' ? Math.round(fontSize * 1.4) : lineHeight;
    const indent = block.type === 'bullet' ? bulletIndent : 0;

    const normalizedText = normalizeText(block.text);
    const lines = buildMarkedLines(doc, normalizedText, fontSize, Math.max(textWidth - indent, 24));

    lines.forEach((line, index) => {
      const lineData: MarkedLine = {
        segments: line.segments,
        bullet: block.type === 'bullet' && index === 0
      };
      addItem({
        kind: 'block',
        height: blockLineHeight,
        blockData: {
          fontSize,
          lineHeight: blockLineHeight,
          indent,
          line: lineData
        }
      });
    });
  });

  const metaChips = Array.isArray((message as any)?.metaChips)
    ? ((message as any).metaChips as string[])
    : [];

  let metaHeight = 0;
  if (metaChips.length > 0) {
    let lineWidth = 0;
    let lines = 1;
    metaChips.forEach(chip => {
      const chipTextWidth = doc.getTextWidth(chip);
      const chipWidth = chipTextWidth + metaChipPaddingX * 2;
      if (lineWidth > 0 && lineWidth + chipWidth > textWidth) {
        lines += 1;
        lineWidth = 0;
      }
      lineWidth += chipWidth + 6;
    });
    metaHeight = lines * metaChipHeight + (lines - 1) * metaChipSpacing;
    addItem({ kind: 'gap', height: metaChipSpacing });
    addItem({ kind: 'meta', height: metaHeight, chips: metaChips });
  }

  addItem({ kind: 'padding', height: bubblePaddingY });

  const bubbleHeight = contentHeight;
  const totalHeight = authorChipHeight + authorChipSpacing + bubbleHeight + bubbleSpacing;

  return {
    bubbleHeight,
    contentHeight,
    metaHeight,
    totalHeight,
    metaChips,
    items
  };
};

const drawBubbleSegmentBackground = (
  doc: jsPDF,
  bubbleX: number,
  bubbleWidth: number,
  segmentTop: number,
  segmentHeight: number,
  isFirst: boolean,
  isLast: boolean,
  bubbleFill: [number, number, number],
  bubbleBorder: [number, number, number]
) => {
  const radius = 8;
  doc.setFillColor(bubbleFill[0], bubbleFill[1], bubbleFill[2]);
  doc.setDrawColor(bubbleBorder[0], bubbleBorder[1], bubbleBorder[2]);

  if (isFirst && isLast) {
    doc.roundedRect(bubbleX, segmentTop, bubbleWidth, segmentHeight, radius, radius, 'FD');
    return;
  }

  if (isFirst) {
    doc.roundedRect(bubbleX, segmentTop, bubbleWidth, segmentHeight, radius, radius, 'FD');
    doc.setFillColor(bubbleFill[0], bubbleFill[1], bubbleFill[2]);
    doc.rect(bubbleX, segmentTop + segmentHeight - radius, radius, radius, 'FD');
    doc.rect(bubbleX + bubbleWidth - radius, segmentTop + segmentHeight - radius, radius, radius, 'FD');
    return;
  }

  if (isLast) {
    doc.roundedRect(bubbleX, segmentTop, bubbleWidth, segmentHeight, radius, radius, 'FD');
    doc.setFillColor(bubbleFill[0], bubbleFill[1], bubbleFill[2]);
    doc.rect(bubbleX, segmentTop, radius, radius, 'FD');
    doc.rect(bubbleX + bubbleWidth - radius, segmentTop, radius, radius, 'FD');
    return;
  }

  doc.rect(bubbleX, segmentTop, bubbleWidth, segmentHeight, 'FD');
};

const renderMetaChips = (
  doc: jsPDF,
  chips: string[] | undefined,
  textStartX: number,
  textWidth: number,
  startY: number
) => {
  if (!chips || chips.length === 0) {
    return 0;
  }

  let cursorY = startY;
  let chipCursorX = textStartX;

  chips.forEach(chip => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(baseFontSize + 1);
    const chipTextWidth = doc.getTextWidth(chip);
    const width = chipTextWidth + metaChipPaddingX * 2;

    if (chipCursorX + width > textStartX + textWidth) {
      chipCursorX = textStartX;
      cursorY += metaChipHeight + metaChipSpacing;
    }

    doc.setFillColor(224, 242, 241);
    doc.setDrawColor(180, 208, 203);
    doc.roundedRect(chipCursorX, cursorY, width, metaChipHeight, 4, 4, 'FD');
    doc.setTextColor(46, 125, 109);
    doc.text(
      chip,
      chipCursorX + metaChipPaddingX,
      cursorY + metaChipHeight / 2 + 2,
      { baseline: 'middle' }
    );

    chipCursorX += width + 6;
  });

  doc.setTextColor(32, 32, 32);

  return (cursorY + metaChipHeight) - startY;
};

const renderMessage = (
  doc: jsPDF,
  message: Message,
  state: RenderState,
  bubbleWidth: number,
  measurement: MessageMeasurement
) => {
  const isUser = message.role === 'user';
  const bubbleX = isUser
    ? state.pageWidth - pdfMargin.right - bubbleWidth
    : pdfMargin.left;
  const textStartX = bubbleX + bubblePaddingX;
  const textWidth = bubbleWidth - bubblePaddingX * 2;
  const bubbleFill: [number, number, number] = isUser ? [227, 242, 253] : [245, 245, 245];
  const bubbleBorder: [number, number, number] = isUser ? [187, 222, 251] : [216, 216, 216];
  const chipFill: [number, number, number] = isUser ? [33, 150, 243] : [232, 245, 253];
  const chipBorder: [number, number, number] = isUser ? [25, 118, 210] : [187, 222, 251];
  const chipText: [number, number, number] = isUser ? [255, 255, 255] : [25, 118, 210];

  const authorLabel = getMessageLabel(message);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(baseFontSize + 1);
  const chipTextWidth = doc.getTextWidth(authorLabel);
  const chipWidth = chipTextWidth + authorChipPaddingX * 2;
  const chipX = isUser ? bubbleX + bubbleWidth - chipWidth : bubbleX;
  const chipY = state.cursorY;

  doc.setFillColor(chipFill[0], chipFill[1], chipFill[2]);
  doc.setDrawColor(chipBorder[0], chipBorder[1], chipBorder[2]);
  doc.roundedRect(chipX, chipY, chipWidth, authorChipHeight, 6, 6, 'FD');
  doc.setTextColor(chipText[0], chipText[1], chipText[2]);
  doc.text(
    authorLabel,
    chipX + authorChipPaddingX,
    chipY + authorChipHeight / 2 + 2,
    { baseline: 'middle' }
  );

  state.cursorY += authorChipHeight + authorChipSpacing;
  const items = measurement.items;
  let segmentIndex = 0;

  while (segmentIndex < items.length) {
    let available = state.pageHeight - pdfMargin.bottom - state.cursorY;
    if (available <= bubblePaddingY) {
      doc.addPage();
      state.cursorY = pdfMargin.top;
      available = state.pageHeight - pdfMargin.bottom - state.cursorY;
    }

    const segmentItems: SegmentItem[] = [];
    let segmentHeight = 0;
    let startIndex = segmentIndex;

    while (segmentIndex < items.length) {
      const item = items[segmentIndex];
      const nextHeight = segmentHeight + item.height;

      if (segmentItems.length === 0 && item.height > available) {
        doc.addPage();
        state.cursorY = pdfMargin.top;
        available = state.pageHeight - pdfMargin.bottom - state.cursorY;
        startIndex = segmentIndex;
        segmentHeight = 0;
        continue;
      }

      if (segmentItems.length > 0 && nextHeight > available) {
        if (segmentItems.length === 1 && segmentItems[0].kind === 'padding') {
          segmentItems.length = 0;
          segmentHeight = 0;
          segmentIndex = startIndex;
          doc.addPage();
          state.cursorY = pdfMargin.top;
          available = state.pageHeight - pdfMargin.bottom - state.cursorY;
          continue;
        }
        break;
      }

      segmentItems.push(item);
      segmentHeight = nextHeight;
      segmentIndex += 1;
    }

    if (segmentItems.length === 0) {
      break;
    }

    const segmentTop = state.cursorY;
    const isFirstSegment = startIndex === 0;
    const isLastSegment = segmentIndex >= items.length;

    drawBubbleSegmentBackground(
      doc,
      bubbleX,
      bubbleWidth,
      segmentTop,
      segmentHeight,
      isFirstSegment,
      isLastSegment,
      bubbleFill,
      bubbleBorder
    );

    doc.setTextColor(32, 32, 32);
    let contentCursorY = segmentTop;

    segmentItems.forEach(item => {
      switch (item.kind) {
        case 'padding':
        case 'gap':
          contentCursorY += item.height;
          break;
        case 'block': {
          if (!item.blockData) {
            contentCursorY += item.height;
            break;
          }
          const { fontSize, lineHeight: blockLineHeight, indent, line } = item.blockData;
          const lineY = contentCursorY;
          let lineX = textStartX + indent;

          if (line.bullet) {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(fontSize);
            doc.text('•', textStartX, lineY, { baseline: 'top' });
          }

          line.segments.forEach(segment => {
            if (!segment.text) return;
            doc.setFont('helvetica', segment.bold ? 'bold' : 'normal');
            doc.setFontSize(fontSize);

            if (/^\s+$/.test(segment.text)) {
              lineX += doc.getTextWidth(segment.text);
            } else {
              doc.text(segment.text, lineX, lineY, { baseline: 'top' });
              lineX += doc.getTextWidth(segment.text);
            }
          });

          contentCursorY += blockLineHeight;
          break;
        }
        case 'meta': {
           const rendered = renderMetaChips(doc, item.chips, textStartX, textWidth, contentCursorY);
           contentCursorY += rendered;
           break;
         }
         default:
           contentCursorY += item.height;
       }
     });

    state.cursorY = segmentTop + segmentHeight;
  }

  state.cursorY += bubbleSpacing;
};

const generateChatTranscriptPdf = () => {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const printableWidth = pageWidth - pdfMargin.left - pdfMargin.right;
  const bubbleWidth = Math.min(pageWidth * bubbleWidthRatio, printableWidth);
  const state: RenderState = {
    cursorY: pdfMargin.top,
    pageWidth,
    pageHeight
  };

  renderFileChips(doc, uploadedFiles.value, state);

  messages.value.forEach(msg => {
    const normalized = normalizeMessage({ ...msg });
    const measurement = measureMessage(doc, normalized, bubbleWidth);
    const minHeightNeeded = authorChipHeight + authorChipSpacing + bubblePaddingY;
    ensureRoom(doc, state, minHeightNeeded);
    renderMessage(doc, normalized, state, bubbleWidth, measurement);
  });

  return doc;
};

const saveLocally = async () => {
  try {
    if (messages.value.length === 0) {
      alert('There is no chat content to save yet.');
      return;
    }
    
    const doc = generateChatTranscriptPdf();
    const now = new Date();
    const filename = `MAIA chat ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}.pdf`;

    // Prefer the File System Access API when available
    // @ts-ignore - File System Access API types not in TypeScript libs
    if ('showSaveFilePicker' in window) {
      try {
        // @ts-ignore
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [
            {
            description: 'PDF files',
            accept: { 'application/pdf': ['.pdf'] }
            }
          ]
        });
        
        const writable = await fileHandle.createWritable();
        await writable.write(await doc.output('blob'));
        await writable.close();
        
        alert('Chat saved successfully!');
        lastLocalSaveSnapshot.value = currentChatSnapshot.value;
        return;
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          return; // user cancelled
        }
        console.warn('File System Access API not available or failed, falling back to download.', err);
      }
    }

    // Fallback: regular download
    doc.save(filename);
    alert('Chat saved successfully!');
    lastLocalSaveSnapshot.value = currentChatSnapshot.value;
  } catch (error) {
    console.error('Error saving chat locally:', error);
    alert(`Failed to save chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const saveToGroup = async () => {
  try {
    if (!props.user?.userId) {
      alert('You must be logged in to save chats to a group');
      return;
    }

    const payload = {
      chatHistory: buildChatHistoryPayload(),
      uploadedFiles: buildUploadedFilePayload(),
      currentUser: props.user.userId,
      connectedKB: getProviderKey(selectedProvider.value)
    };

    let attemptedUpdate = false;

    if (isDeepLink.value) {
      if (!currentSavedChatId.value && deepLinkChatId.value) {
        currentSavedChatId.value = deepLinkChatId.value;
        currentSavedChatShareId.value = deepLinkShareId.value || currentSavedChatShareId.value;
      }
      if (!currentSavedChatId.value) {
        alert('Unable to locate the shared chat to update. Please refresh and try again.');
        return;
      }
    }

    if (currentSavedChatId.value) {
      attemptedUpdate = true;
      const updateResponse = await fetch(`/api/save-group-chat/${encodeURIComponent(currentSavedChatId.value)}`, {
        method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
        credentials: 'include',
      body: JSON.stringify({
          ...payload,
          shareId: currentSavedChatShareId.value
        })
      });

      if (updateResponse.status === 404) {
        // Existing chat was deleted or not found; fall back to creating a new chat
        currentSavedChatId.value = null;
        currentSavedChatShareId.value = null;
        attemptedUpdate = false;
      } else if (!updateResponse.ok) {
        const errorData = await updateResponse.json().catch(() => ({ message: updateResponse.statusText }));
        throw new Error(errorData.message || 'Failed to update saved chat');
      } else {
        const result = await updateResponse.json();
        const shareId = result.shareId || currentSavedChatShareId.value;

        currentSavedChatId.value = result.chatId || currentSavedChatId.value;
        currentSavedChatShareId.value = shareId || null;
        lastGroupSaveSnapshot.value = currentChatSnapshot.value;

        alert(`Chat updated successfully!${shareId ? ` Share ID: ${shareId}` : ''}`);

        loadSavedChatCount();
        return;
      }
    }

    if (!attemptedUpdate) {
      const createResponse = await fetch('/api/save-group-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      if (!createResponse.ok) {
        const errorData = await createResponse.json().catch(() => ({ message: createResponse.statusText }));
      throw new Error(errorData.message || 'Failed to save chat');
    }

      const result = await createResponse.json();
    
      currentSavedChatId.value = result.chatId || null;
      currentSavedChatShareId.value = result.shareId || null;
      lastGroupSaveSnapshot.value = currentChatSnapshot.value;
    
      alert(`Chat saved successfully!${result.shareId ? ` Share ID: ${result.shareId}` : ''}`);

    loadSavedChatCount();
    }
  } catch (error) {
    console.error('Error saving to group:', error);
    alert(`Failed to save chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const showSavedChats = () => {
  showSavedChatsModal.value = true;
  loadSavedChatCount();
};

const loadSavedChatCount = async () => {
  if (!props.user?.userId) return;
  
  try {
    const endpoint = isDeepLink.value
      ? '/api/user-chats'
      : `/api/user-chats?userId=${encodeURIComponent(props.user.userId)}`;
    const response = await fetch(endpoint, {
      credentials: 'include'
    });
    if (response.ok) {
      const result = await response.json();
      savedChatCount.value = result.count || 0;
    }
  } catch (error) {
    console.error('Failed to load chat count:', error);
  }
};

async function loadDeepLinkChat(force = false) {
  const shareId = deepLinkShareId.value;
  if (!shareId) return;
  if (hasLoadedDeepLinkChat.value && !force) return;

  try {
    const response = await fetch(`/api/load-chat-by-share/${encodeURIComponent(shareId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(response.statusText || 'Failed to load shared chat');
    }
    const result = await response.json();
    if (result?.chat) {
      handleChatSelected(result.chat);
      hasLoadedDeepLinkChat.value = true;
      if (result.chat._id) {
        currentSavedChatId.value = result.chat._id;
      } else if (deepLinkChatId.value) {
        currentSavedChatId.value = deepLinkChatId.value;
      }

      if (result.chat.shareId) {
        currentSavedChatShareId.value = result.chat.shareId;
      } else {
        currentSavedChatShareId.value = shareId;
      }
    }
  } catch (error) {
    console.error('Failed to load deep link chat:', error);
  }
}

const handleChatDeleted = (chatId: string) => {
  if (currentSavedChatId.value === chatId) {
    currentSavedChatId.value = null;
    currentSavedChatShareId.value = null;
    lastGroupSaveSnapshot.value = null;
  }
  loadSavedChatCount();
};

const handleChatSelected = async (chat: any) => {
  currentSavedChatId.value = chat._id || null;
  currentSavedChatShareId.value = chat.shareId || null;
  if (deepLinkShareId.value) {
    hasLoadedDeepLinkChat.value = true;
    deepLinkInfoLocal.value = {
      shareId: deepLinkShareId.value,
      chatId: chat._id || null
    };
    emit('update:deepLinkInfo', deepLinkInfoLocal.value);
  }

  // For deep link users, load the owner's deep link Private AI setting (then reload providers)
  if (isDeepLink.value) {
    if (chat.patientOwner) {
      try {
        const response = await fetch(`/api/user-settings?userId=${encodeURIComponent(chat.patientOwner)}`, {
          credentials: 'include'
        });
        if (response.ok) {
          const result = await response.json();
          ownerAllowDeepLinkPrivateAI.value = result.allowDeepLinkPrivateAI !== undefined ? result.allowDeepLinkPrivateAI : true;
        } else {
          ownerAllowDeepLinkPrivateAI.value = true;
        }
      } catch (error) {
        console.warn('Failed to load owner deep link setting, defaulting to enabled:', error);
        ownerAllowDeepLinkPrivateAI.value = true;
      }
    } else {
      ownerAllowDeepLinkPrivateAI.value = true; // No owner id (e.g. old chat) – allow Private AI
    }
    await loadProviders();
  }

  // Load the chat history
  if (chat.chatHistory) {
    const normalizedHistory = chat.chatHistory.map((msg: Message) => normalizeMessage(msg));
    messages.value = normalizedHistory;
    originalMessages.value = JSON.parse(JSON.stringify(normalizedHistory)); // Keep original in sync
    trulyOriginalMessages.value = JSON.parse(JSON.stringify(normalizedHistory)); // Store truly original for filtering
  }
  
  // Load the uploaded files
  if (chat.uploadedFiles) {
    uploadedFiles.value = chat.uploadedFiles.map((file: any) => ({
      id: file.id || `file-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      name: file.name,
      size: file.size,
      type: file.type,
      content: '', // Content not saved to reduce size
      originalFile: null as any,
      bucketKey: file.bucketKey,
      bucketPath: file.bucketPath,
      uploadedAt: file.uploadedAt ? new Date(file.uploadedAt) : new Date()
    }));
  } else {
    uploadedFiles.value = [];
  }

  nextTick(() => {
    const snapshot = currentChatSnapshot.value;
    lastLocalSaveSnapshot.value = snapshot;
    lastGroupSaveSnapshot.value = snapshot;
  });

  if (deepLinkShareId.value) {
    deepLinkInfoLocal.value = {
      shareId: deepLinkShareId.value,
      chatId: chat._id || null
    };
    emit('update:deepLinkInfo', deepLinkInfoLocal.value);
  }
};

// Reset chat when needed (kept for reference)
// const _clearChat = () => {
//   messages.value = [];
//   uploadedFiles.value = [];
// };

const startEditing = (idx: number) => {
  if (!editingMessageIdx.value.includes(idx)) {
    editingMessageIdx.value.push(idx);
    const message = messages.value[idx];
    if (message) {
      editingOriginalContent.value[idx] = message.content;
    }
  }
};

const saveEditedMessage = (idx: number) => {
  const editIndex = editingMessageIdx.value.indexOf(idx);
  if (editIndex > -1) {
    editingMessageIdx.value.splice(editIndex, 1);
  }
  delete editingOriginalContent.value[idx];
  // Sync originalMessages when message is edited (edited content becomes the new "original")
  if (originalMessages.value[idx] && messages.value[idx]) {
    originalMessages.value[idx].content = messages.value[idx].content;
  }
};

const cancelEditing = (idx: number) => {
  const original = editingOriginalContent.value[idx];
  if (original !== undefined && messages.value[idx]) {
    messages.value[idx].content = original;
  }
  const editIndex = editingMessageIdx.value.indexOf(idx);
  if (editIndex > -1) {
    editingMessageIdx.value.splice(editIndex, 1);
  }
  delete editingOriginalContent.value[idx];
};

const confirmDeleteMessage = (idx: number) => {
  const message = messages.value[idx];
  messageToDelete.value = message;
  
  // Check if deleting an assistant message with a preceding user message
  if (message.role === 'assistant' && idx > 0 && messages.value[idx - 1].role === 'user') {
    precedingUserMessage.value = messages.value[idx - 1];
  } else {
    precedingUserMessage.value = null;
  }
  
  showDeleteDialog.value = true;
};

const deleteMessageConfirmed = () => {
  if (!messageToDelete.value) return;
  
  const idx = messages.value.findIndex(msg => msg === messageToDelete.value);
  if (idx === -1) return;
  
  // Remove the message
  messages.value.splice(idx, 1);
  // Also remove from originalMessages to keep in sync
  if (originalMessages.value[idx]) {
    originalMessages.value.splice(idx, 1);
  }
  
  // If there was a preceding user message, remove it too
  if (precedingUserMessage.value && idx > 0) {
    const userIdx = idx - 1;
    if (messages.value[userIdx]?.role === 'user') {
      messages.value.splice(userIdx, 1);
      // Also remove from originalMessages
      if (originalMessages.value[userIdx]) {
        originalMessages.value.splice(userIdx, 1);
      }
      delete editingOriginalContent.value[userIdx];
    }
  }
  
  // Remove from editing if it was being edited
  const editIndex = editingMessageIdx.value.indexOf(idx);
  if (editIndex > -1) {
    editingMessageIdx.value.splice(editIndex, 1);
  }
  
  // Close modal and reset
  showDeleteDialog.value = false;
  messageToDelete.value = null;
  precedingUserMessage.value = null;
  // Deletion counts as a change, so leave snapshots untouched and let the user re-save if needed
};

// Auto-scroll chat to bottom when messages change
const scrollToBottom = async () => {
  await nextTick();
  await nextTick(); // Double nextTick to ensure DOM is fully updated
  if (chatMessagesRef.value) {
    // Use setTimeout to ensure DOM has fully updated
    setTimeout(() => {
      if (chatMessagesRef.value) {
        chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight;
      }
    }, 0);
  }
};

// Watch for specific changes and trigger scroll with flush: 'post'
watch(() => [messages.value.length, messages.value[messages.value.length - 1]?.content], () => {
  scrollToBottom();
}, { flush: 'post' });

const startSetupWizardPolling = () => {
  if (!props.user?.userId) {
    initialLoadComplete.value = true;
    return;
  }
  if (props.suppressWizard) {
    initialLoadComplete.value = true;
    return;
  }
  const userId = props.user.userId;
  const agentSetupKey = wizardAgentSetupStartedKey(userId);
  const maxAttempts = 60; // 15 minutes at 15s
  let attempts = 0;
  agentSetupTimedOut.value = false;
  agentSetupPollingActive.value = true;
  wizardStage1Complete.value = false;
  try {
    const stored = agentSetupKey ? sessionStorage.getItem(agentSetupKey) : null;
    if (stored) {
      const startedAt = parseInt(stored, 10);
      const maxAgeMs = 20 * 60 * 1000;
      if (!isNaN(startedAt) && (Date.now() - startedAt) < maxAgeMs) {
        agentSetupElapsed.value = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      } else {
        if (agentSetupKey) sessionStorage.removeItem(agentSetupKey);
        agentSetupElapsed.value = 0;
        if (agentSetupKey) sessionStorage.setItem(agentSetupKey, String(Date.now()));
      }
    } else {
      agentSetupElapsed.value = 0;
      if (agentSetupKey) sessionStorage.setItem(agentSetupKey, String(Date.now()));
    }
  } catch {
    agentSetupElapsed.value = 0;
  }

  refreshWizardState()
    .then(() => {
      // ── Safari/basic reload recovery: resume guided flow if indexing already done ──
      // On reload wizardFlowPhase resets to 'done'. If the server shows indexing
      // complete + agent ready but medications or summary are still pending, the
      // user was mid-guided-flow. Resume it so the wizard doesn't get stuck.
      if (
        wizardFlowPhase.value === 'done' &&
        (safariFolderName.value || localFolderHandle.value) &&
        indexingStatus.value?.phase === 'complete' &&
        wizardStage1Complete.value
      ) {
        if (!wizardPatientSummary.value && wizardCurrentMedications.value) {
          // Meds done, summary pending → resume at summary phase
          wizardFlowPhase.value = 'summary';
          myStuffInitialTab.value = 'summary';
          wizardRequestAction.value = 'generate-summary';
          showMyStuffDialog.value = true;
        } else if (!wizardCurrentMedications.value) {
          // Meds still pending → resume at medications phase
          wizardFlowPhase.value = 'medications';
          try {
            sessionStorage.setItem('autoProcessInitialFile', 'true');
            sessionStorage.setItem('wizardMyListsAuto', 'true');
          } catch { /* ignore */ }
          myStuffInitialTab.value = 'lists';
          showMyStuffDialog.value = true;
        }
      }

      if (!shouldHideSetupWizard.value && !showAgentSetupDialog.value && !wizardDismissed.value) {
        showAgentSetupDialog.value = true;
        stopAgentSetupTimer();
        agentSetupTimer = setInterval(() => {
          agentSetupElapsed.value += 1;
        }, 1000);
      }
      initialLoadComplete.value = true;
    })
    .catch(() => {
      initialLoadComplete.value = true;
    });

  const poll = async () => {
    attempts += 1;
    try {
      const response = await fetch('/api/agent-setup-status', {
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error(`Status ${response.status}`);
      }
      const result = await response.json();
      if (result?.status) {
        agentSetupStatus.value = result.status;
      }
      wizardAgentReady.value = !!result?.endpointReady;
      await refreshWizardState();

      if (shouldHideSetupWizard.value) {
        stopAgentSetupTimer();
        agentSetupPollingActive.value = false;
        showAgentSetupDialog.value = false;
        agentSetupTimedOut.value = false;
        return;
      }

      if (result?.endpointReady) {
        agentSetupStatus.value = 'READY';
        wizardStage1Complete.value = true;
        agentSetupPollingActive.value = false;
        stopAgentSetupTimer();
        addSetupLogLine('Agent Status', `Agent deployed and ready (${agentSetupElapsed.value}s)`, true);
        try {
          if (agentSetupKey) sessionStorage.removeItem(agentSetupKey);
        } catch { /* ignore */ }
        updateContextualTip();
        // Refetch providers so Private AI appears without page reload (await so UI updates before we return)
        await loadProviders();
        return;
      }

      if (!shouldHideSetupWizard.value && !showAgentSetupDialog.value && !wizardDismissed.value) {
        showAgentSetupDialog.value = true;
        stopAgentSetupTimer();
        agentSetupTimer = setInterval(() => {
          agentSetupElapsed.value += 1;
        }, 1000);
      }
    } catch (error) {
      console.warn('Agent setup status check failed:', error);
    }

    if (attempts < maxAttempts) {
      setTimeout(poll, 15000);
    } else {
      agentSetupTimedOut.value = true;
      agentSetupPollingActive.value = false;
      stopAgentSetupTimer();
      try {
        if (agentSetupKey) sessionStorage.removeItem(agentSetupKey);
      } catch { /* ignore */ }
    }
  };

  poll();
};

// Indexing status tracking
const indexingStatus = ref<{
  active: boolean;
  phase: string;
  tokens: string;
  filesIndexed: number;
  progress: number;
} | null>(null);
const stage3IndexingActive = computed(() =>
  stage3IndexingPending.value ||
  indexingStatus.value?.phase === 'indexing' ||
  !!stage3IndexingPoll.value
);

/** True when the user has connected a local folder (Chrome handle or Safari folder name). */
const setupFolderConnected = computed(() => !!localFolderHandle.value || !!safariFolderName.value);

/** Checklist file items for the simplified setup wizard. */
const setupChecklistFiles = computed(() => {
  // Build from setup log lines (files uploaded during auto-run)
  const uploadedSet = new Set<string>();
  const errorSet = new Set<string>();
  const runningSet = new Set<string>();
  for (const line of setupLogLines.value) {
    if (line.step === 'File Uploaded' && line.ok) {
      // Extract filename: "filename.pdf (123 KB)" or "filename.pdf (123 KB) [Apple Health]"
      const name = line.detail.split(' (')[0];
      if (name) uploadedSet.add(name);
    } else if ((line.step === 'Upload Failed' || line.step === 'Upload Error') && !line.ok) {
      const name = line.detail.split(':')[0];
      if (name) errorSet.add(name);
    }
  }
  // If auto-run is active, files being uploaded show as running
  if (localFolderAutoRunActive.value && localFolderAutoRunPhase.value.startsWith('Uploading ')) {
    const match = localFolderAutoRunPhase.value.match(/^Uploading (.+)\.\.\.$/);
    if (match) runningSet.add(match[1]);
  }

  // Combine: local folder files (pending/running) + uploaded files (done) + failed files (error)
  const items: Array<{ name: string; status: 'pending' | 'running' | 'done' | 'error'; progress?: string; isAppleHealth?: boolean }> = [];
  const seen = new Set<string>();

  // Files from local folder scan (not yet uploaded)
  for (const f of localFolderFiles.value) {
    if (f.name.toLowerCase() === 'maia-setup-log.pdf' || f.name.toLowerCase() === 'maia-setup-log.json') continue;
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    const isApple = stage3DisplayFiles.value.some(df => df.name === f.name && df.isAppleHealth);
    if (uploadedSet.has(f.name)) {
      items.push({ name: f.name, status: 'done', progress: 'Uploaded', isAppleHealth: isApple });
    } else if (errorSet.has(f.name)) {
      items.push({ name: f.name, status: 'error', isAppleHealth: isApple });
    } else if (runningSet.has(f.name)) {
      items.push({ name: f.name, status: 'running', isAppleHealth: isApple });
    } else {
      items.push({ name: f.name, status: 'pending', isAppleHealth: isApple });
    }
  }

  // Files from stage3 that may have been uploaded before folder was scanned (e.g. Safari)
  for (const f of stage3DisplayFiles.value) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    items.push({ name: f.name, status: f.inKnowledgeBase ? 'done' : 'pending', progress: f.inKnowledgeBase ? 'Uploaded' : undefined, isAppleHealth: f.isAppleHealth });
  }

  return items;
});

// Log when indexing completes (watch indexingStatus phase transition to 'complete')
// Placed here because indexingStatus must be declared before the watcher.
watch(
  () => indexingStatus.value?.phase,
  (phase, oldPhase) => {
    if (phase === 'complete' && oldPhase !== 'complete' && (localFolderHandle.value || safariFolderName.value)) {
      const tokens = indexingStatus.value?.tokens || '0';
      const filesIndexed = indexingStatus.value?.filesIndexed || 0;
      const elapsed = stage3IndexingStartedAt.value
        ? Math.round((Date.now() - stage3IndexingStartedAt.value) / 1000)
        : 0;
      addSetupLogLine('Indexing Complete', `${filesIndexed} file(s) indexed, ${tokens} tokens, ${elapsed}s elapsed`, true);
      void generateSetupLogPdf();
    }
  }
);

// Log when Current Medications becomes verified
watch(
  () => wizardCurrentMedications.value,
  (verified, was) => {
    if (verified && !was && (localFolderHandle.value || safariFolderName.value)) {
      addSetupLogLine('Current Medications', 'Current Medications verified', true);
      void generateSetupLogPdf();
    }
  }
);

// Guided flow: when indexing completes AND agent is ready, close wizard and start medications flow
watch(
  [() => indexingStatus.value?.phase, () => wizardStage1Complete.value],
  ([phase, agentReady]) => {
    if (
      phase === 'complete' &&
      agentReady &&
      (localFolderHandle.value || safariFolderName.value) &&
      wizardFlowPhase.value === 'running'
    ) {
      // Both indexing and agent are done — transition to medications phase
      addSetupLogLine('Wizard Flow', 'Indexing and agent both complete — starting guided review', true);
      void generateSetupLogPdf();
      showAgentSetupDialog.value = false;
      if (wizardTimeoutTimer) {
        clearTimeout(wizardTimeoutTimer);
        wizardTimeoutTimer = null;
      }
      wizardFlowPhase.value = 'medications';
      // Open MyStuff on lists tab (same as handleWizardMedsAction)
      try {
        sessionStorage.setItem('autoProcessInitialFile', 'true');
        sessionStorage.setItem('wizardMyListsAuto', 'true');
      } catch { /* ignore */ }
      myStuffInitialTab.value = 'lists';
      showMyStuffDialog.value = true;
    }
  }
);

const handleIndexingStarted = (data: { jobId: string; phase: string }) => {
  stage3IndexingStartedAt.value = Date.now();
  stage3IndexingCompletedAt.value = null;
  try {
    const k = wizardStage3IndexingStartedKey(props.user?.userId);
    if (k) sessionStorage.setItem(k, String(stage3IndexingStartedAt.value));
  } catch { /* ignore */ }
  indexingStatus.value = {
    active: true,
    phase: data.phase,
    tokens: '0',
    filesIndexed: 0,
    progress: 0
  };
  startStage3ElapsedTimer();
  updateContextualTip();
};

const handleIndexingStatusUpdate = (data: { jobId: string; phase: string; tokens: string; filesIndexed: number; progress: number }) => {
  if (indexingStatus.value) {
    indexingStatus.value.phase = data.phase;
    indexingStatus.value.tokens = data.tokens;
    indexingStatus.value.filesIndexed = data.filesIndexed;
    indexingStatus.value.progress = data.progress;
    updateContextualTip();
  }
};

const handleIndexingFinished = (_data: { jobId: string; phase: string; error?: string }) => {
  stage3IndexingCompletedAt.value = Date.now();
  indexingStatus.value = null;
  stopStage3ElapsedTimer();
  try {
    const k = wizardStage3IndexingStartedKey(props.user?.userId);
    if (k) sessionStorage.removeItem(k);
  } catch { /* ignore */ }
  // Update status tip to show normal status
  updateContextualTip();
  refreshWizardState();
  // Prompt to update Patient Summary, but not during wizard-controlled guided flow or if already dismissed this session
  if (wizardFlowPhase.value !== 'medications' && wizardFlowPhase.value !== 'summary' && !postIndexingSummaryDismissedThisSession.value) {
    showPostIndexingSummaryPrompt.value = true;
  }
};

const handlePostIndexingUpdateSummary = () => {
  showPostIndexingSummaryPrompt.value = false;
  myStuffInitialTab.value = 'summary';
  wizardRequestAction.value = 'generate-summary';
  if (!showMyStuffDialog.value) {
    showMyStuffDialog.value = true;
  }
  // If dialog is already open, the requestAction watcher handles the switch
};

const handleFilesArchived = (archivedBucketKeys: string[]) => {
  // Remove files from uploadedFiles that match the given bucketKeys so they no longer show as
  // chat badges or get included in chat context. Used when files are moved to archived, or to
  // the KB folder (userId/<kbName>/) from the wizard or Saved Files.
  uploadedFiles.value = uploadedFiles.value.filter(file => {
    if (!file.bucketKey) return true; // Keep files without bucketKey (text files)
    // Remove files whose bucketKey matches any archived key
    return !archivedBucketKeys.includes(file.bucketKey);
  });
  
  // If PDF viewer is open and showing a file that was archived/moved, close it
  // Empty array means files were moved (from cancel operation) - close viewer to force refresh
  if (showPdfViewer.value && (archivedBucketKeys.length === 0 || 
      (viewingFile.value && viewingFile.value.bucketKey && 
       archivedBucketKeys.includes(viewingFile.value.bucketKey)))) {
    showPdfViewer.value = false;
    viewingFile.value = null;
  }
  
  // Update status tip immediately after files are archived
  updateContextualTip();
};

const handleFileAddedToKb = async (data: { fileName: string; bucketKey: string }) => {
  // Copy the file to the local MAIA folder so it's available for offline restore
  // Try to reconnect if handle is missing (may work if user gesture chain is still active)
  if (!localFolderHandle.value && props.user?.userId) {
    try {
      const result = await reconnectLocalFolderWithGesture(props.user.userId);
      if (result) {
        localFolderHandle.value = result.handle;
        localFolderName.value = result.folderName;
      }
    } catch { /* ignore */ }
  }
  if (!localFolderHandle.value) {
    return;
  }
  try {
    // Fetch file content via the proxy endpoint
    const resp = await fetch(`/api/files/proxy-pdf/${encodeURIComponent(data.bucketKey)}`, {
      credentials: 'include'
    });
    if (!resp.ok) {
      console.warn(`[localFolder] Failed to fetch file for local copy: ${resp.status}`);
      return;
    }
    const blob = await resp.blob();
    await writeFileToFolder(localFolderHandle.value, data.fileName, blob);

    // Update maia-state.json to reflect the new file
    try {
      const state = await readStateFile(localFolderHandle.value);
      if (state) {
        const files = state.files || [];
        const existing = files.find(f => f.fileName === data.fileName);
        if (!existing) {
          files.push({
            fileName: data.fileName,
            size: blob.size,
            cloudStatus: 'indexed' as const,
            bucketKey: data.bucketKey
          });
          state.files = files;
          await writeStateFile(localFolderHandle.value, state);
        }
      }
    } catch (stateErr) {
      console.warn('[localFolder] Failed to update maia-state.json:', stateErr);
    }

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: `"${data.fileName}" copied to local MAIA folder`,
        timeout: 3000
      });
    }
  } catch (err) {
    console.warn('[localFolder] Failed to copy file to local folder:', err);
  }
};

const handleMessagesFiltered = async (filteredMessages: Message[]) => {
  // Replace current messages with filtered messages
  messages.value = filteredMessages;
  
  // Update originalMessages to reflect current state (for display purposes)
  // BUT keep trulyOriginalMessages unchanged so we can filter again if needed
  originalMessages.value = JSON.parse(JSON.stringify(filteredMessages));
  
  // Force Vue to re-render by triggering a reactive update
  await nextTick();
  
  // Scroll to bottom to show the filtered messages
  setTimeout(() => {
    if (chatMessagesRef.value) {
      chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight;
    }
  }, 100);
};

const handleDiaryPosted = (diaryContent: string) => {
  // Add diary content as a user message to the chat
  const diaryMessage: Message = {
    role: 'user',
    content: diaryContent,
    authorType: 'user',
    authorLabel: 'Patient Diary',
    name: 'Patient Diary'
  };
  
  messages.value.push(diaryMessage);
    originalMessages.value.push(diaryMessage);
    trulyOriginalMessages.value.push(JSON.parse(JSON.stringify(diaryMessage)));
  
  // Scroll to bottom
  nextTick(() => {
    if (chatMessagesRef.value) {
      chatMessagesRef.value.scrollTop = chatMessagesRef.value.scrollHeight;
    }
  });
};

const handleReferenceFileAdded = async (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string; isReference: boolean }) => {
  // Add reference file to uploadedFiles (similar to regular file upload)
  try {
    // For PDF files, we need to parse them
    if (file.fileType === 'pdf') {
      // Fetch and parse PDF from bucket
      const parseResponse = await fetch(`/api/files/parse-pdf-from-bucket/${encodeURIComponent(file.bucketKey)}`, {
        method: 'GET',
        credentials: 'include'
      });
      
      if (parseResponse.ok) {
        const parseResult = await parseResponse.json();
        const uploadedFile: UploadedFile = {
          id: `ref-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          name: file.fileName,
          size: file.fileSize,
          type: 'pdf',
          content: parseResult.text || '',
          originalFile: null as any,
          bucketKey: file.bucketKey,
          bucketPath: file.bucketKey.split('/').slice(0, -1).join('/'),
          fileUrl: file.fileUrl,
          uploadedAt: new Date(file.uploadedAt),
          isReference: true
        };
        uploadedFiles.value.push(uploadedFile);
      }
    } else {
      // For text files, fetch content
      const textResponse = await fetch(`/api/files/get-text/${encodeURIComponent(file.bucketKey)}`, {
        method: 'GET',
        credentials: 'include'
      });
      
      if (textResponse.ok) {
        const textResult = await textResponse.json();
        // Determine file type: markdown, text, or other (pdf is already handled in the if branch above)
        const fileType = file.fileType === 'markdown' ? 'markdown' : 'text';
        const uploadedFile: UploadedFile = {
          id: `ref-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          name: file.fileName,
          size: file.fileSize,
          type: fileType,
          content: textResult.content || textResult.text || '',
          originalFile: null as any,
          bucketKey: file.bucketKey,
          bucketPath: file.bucketKey.split('/').slice(0, -1).join('/'),
          fileUrl: file.fileUrl,
          uploadedAt: new Date(file.uploadedAt),
          isReference: true
        };
        uploadedFiles.value.push(uploadedFile);
      }
    }
  } catch (error) {
    console.error('Error adding reference file to chat:', error);
  }
};

const handleCurrentMedicationsSaved = async () => {
  wizardCurrentMedications.value = true;
  wizardStage2Complete.value = true;
  wizardStage2Pending.value = false;
  wizardStage2NoDevice.value = false;
  await refreshWizardState();
  // Guided flow: advance from medications → summary
  if (wizardFlowPhase.value === 'medications') {
    wizardFlowPhase.value = 'summary';
    addSetupLogLine('Wizard Flow', 'Current Medications saved — opening Patient Summary', true);
    void generateSetupLogPdf();
    // Switch tab and trigger summary generation in-place via requestAction
    myStuffInitialTab.value = 'summary';
    wizardRequestAction.value = 'generate-summary';
  }
};

const handleMyStuffShowSummary = () => {
  myStuffInitialTab.value = 'summary';
  wizardRequestAction.value = 'generate-summary';
};

const handlePatientSummarySaved = async () => {
  // Saving a new summary does not mean it was verified
  wizardPatientSummary.value = false;
  showAgentSetupDialog.value = false;
  wizardDismissed.value = true;
  await refreshWizardState();
  // Guided flow: saving summary also completes the flow
  if (wizardFlowPhase.value === 'summary') {
    wizardFlowPhase.value = 'done';
    addSetupLogLine('Wizard Flow', 'Patient Summary saved — wizard complete', true);
    persistWizardCompletion();
    void generateSetupLogPdf();
    emit('wizard-complete');
    // Leave MyStuff open — user can close when ready
  }
};

const handlePatientSummaryVerified = async () => {
  wizardPatientSummary.value = true;
  persistWizardCompletion();
  showAgentSetupDialog.value = false;
  wizardDismissed.value = true;
  await refreshWizardState();
  // Guided flow: verifying summary completes the flow
  if (wizardFlowPhase.value === 'summary') {
    wizardFlowPhase.value = 'done';
    addSetupLogLine('Wizard Flow', 'Patient Summary verified — wizard complete', true);
    void generateSetupLogPdf();
    emit('wizard-complete');
    // Leave MyStuff open — user can close when ready
  }
};

const handleRehydrationFileRemoved = (payload: { bucketKey?: string; fileName?: string }) => {
  emit('rehydration-file-removed', payload);
};

// Map workflow stages to user-friendly tips
const getWorkflowTip = (workflowStage: string | null, hasFilesInKB: boolean = false): string => {
  const tips: Record<string, string> = {
    'request_sent': 'Support requested. You will be notified when your private AI agent is ready.',
    'agent_deployed': 'Your agent is ready. Use the paperclip to import files for your knowledge base.',
    'files_stored': hasFilesInKB ? 'Ready to chat' : 'Update your knowledge base using the [Stored Files] tab.',
    'files_archived': 'Update your knowledge base using the [Stored Files] tab.',
    'indexing': 'Knowledge base being indexed. This can take up to 60 minutes.',
    'patient_summary': 'Your patient summary is available. Ask your agent for it in the chat anytime.',
    'link_stored': 'Open [Saved Chats] to restore one or share a deep link.'
  };
  
  return tips[workflowStage || ''] || '';
};

const updateContextualTip = async () => {
  if (!props.user?.userId) {
    contextualTip.value = 'User not logged in';
    return;
  }

  // Priority 1: If indexing is active, show indexing status
  if (indexingStatus.value && indexingStatus.value.active) {
    const status = indexingStatus.value;
    if (status.phase === 'indexing' || status.phase === 'indexing_started') {
      contextualTip.value = 'Knowledge base being indexed. This can take up to 60 minutes.';
    } else if (status.phase === 'complete') {
      contextualTip.value = `KB Indexing Complete: ${status.filesIndexed} files indexed`;
      // Clear after a short delay
      setTimeout(() => {
        indexingStatus.value = null;
        updateContextualTip();
      }, 3000);
    } else if (status.phase === 'error') {
      contextualTip.value = 'KB Indexing Error';
      // Clear after a short delay
      setTimeout(() => {
        indexingStatus.value = null;
        updateContextualTip();
      }, 5000);
    } else {
      contextualTip.value = `KB Setup: ${status.phase}`;
    }
    return;
  }

  try {
    // Priority 2: Fetch user document to get workflowStage
    const userResponse = await fetch(`/api/user-status?userId=${encodeURIComponent(props.user.userId)}`, {
      credentials: 'include'
    });

    if (!userResponse.ok) {
      contextualTip.value = 'Unable to load status';
      userResourceStatus.value = null;
      return;
    }

    const userData = await userResponse.json();
    const workflowStage = userData.workflowStage || null;
    const hasKB = !!userData.hasKB;
    const hasFilesInKB = !!userData.hasFilesInKB;
    userResourceStatus.value = {
      hasAgent: !!userData.hasAgent,
      kbStatus: userData.kbStatus || 'none',
      hasKB: hasKB,
      hasFilesInKB: hasFilesInKB,
      workflowStage: workflowStage
    };
    
    // Check if workflowStage is 'indexing' (even if frontend polling isn't active)
    if (workflowStage === 'indexing') {
      contextualTip.value = 'Knowledge base being indexed. This can take up to 60 minutes.';
      return;
    }
    
    // Priority 3: Check UI state (public_llm, chat_modified)
    // These are computed, not saved to database
    if (selectedProvider.value !== 'Private AI') {
      contextualTip.value = 'Public AIs see only what you see in the chat, including any paperclip documents.';
      return;
    }
    
    if (messages.value.length > 0) {
      contextualTip.value = 'You can save the chat to your computer or save it online.';
      return;
    }

    // Priority 4: Get tip for workflow stage
    const tip = getWorkflowTip(workflowStage, hasFilesInKB);
    if (tip) {
      contextualTip.value = tip;
    } else {
      // Fallback to default message if no tip found
      // If no KB files, show Tip 7 message
      contextualTip.value = hasFilesInKB ? 'Ready to chat' : 'Ready to chat but your knowledge base is still empty.';
    }
  } catch (error) {
    console.error('Failed to update contextual tip:', error);
    contextualTip.value = 'Error loading status';
    userResourceStatus.value = null;
  }
};

onMounted(async () => {
  // no-op
  void loadWizardMessages();

  // Detect File System Access API support
  localFolderSupported.value = isFileSystemAccessSupported();

  // Load owner's deep link setting first, then providers
  await loadOwnerDeepLinkSetting();
  await loadProviders();
  loadSavedChatCount();

  if (!isDeepLink.value) {
    // Try to reconnect to a previously chosen local folder (silent on Chrome 122+)
    if (localFolderSupported.value) {
      void tryReconnectLocalFolder();
    }

    // Recover Safari folder session from localStorage on reload.
    // If we had a safariFolderName but lost the live File objects (reload),
    // we can still let the wizard show server-sourced progress. If files
    // are already indexed, the watchers won't need the folder handle at all.
    if (props.folderAccessTier === 'safari' || props.folderAccessTier === 'basic') {
      try {
        const sfKey = `safariFolderName-${props.user?.userId}`;
        const stored = sfKey ? localStorage.getItem(sfKey) : null;
        if (stored && !safariFolderName.value) {
          safariFolderName.value = stored;
          localFolderName.value = stored;
          // We have the name but no live File objects — mark that a re-select
          // may be needed if the wizard still requires file uploads.
          safariNeedsReselect.value = true;
        }
      } catch { /* ignore */ }
    }

    startSetupWizardPolling();
    updateContextualTip();
    setTimeout(() => void checkAndShowNeedsIndexingPrompt(), 800);

    // Update tip immediately when context changes (no polling needed for these)
    watch(() => savedChatCount.value, () => {
      updateContextualTip();
    });
    
    watch(() => messages.value.length, () => {
      updateContextualTip();
    });
    
    watch(() => selectedProvider.value, () => {
      updateContextualTip();
    });

    watch(() => showMyStuffDialog.value, (isOpen, wasOpen) => {
      if (wasOpen && !isOpen) {
        // During guided flow, prevent closing — reopen on the appropriate tab
        if (wizardFlowPhase.value === 'medications') {
          void nextTick(() => {
            myStuffInitialTab.value = 'lists';
            showMyStuffDialog.value = true;
          });
          return;
        }
        if (wizardFlowPhase.value === 'summary') {
          void nextTick(() => {
            myStuffInitialTab.value = 'summary';
            wizardRequestAction.value = 'generate-summary';
            showMyStuffDialog.value = true;
          });
          return;
        }
        if (wizardStage2Pending.value) {
          wizardStage2Pending.value = false;
          refreshWizardState();
        }
        void checkAndShowNeedsIndexingPrompt();
      }
    });
    
    // Conditional polling: only poll when workflowStage requires monitoring
    // Only 'indexing' and 'patient_summary' need polling
    // 'request_sent' doesn't need polling - approval can take hours/days, user will reload to check
    const shouldPollStatus = computed(() => {
      const stage = userResourceStatus.value?.workflowStage;
      return stage === 'indexing' || 
             stage === 'patient_summary';
    });
    
    // Watch for 'request_sent' stage to show modal (only once per session)
    watch(() => userResourceStatus.value?.workflowStage, (newStage) => {
      if (newStage === 'request_sent' && !requestSentModalShown.value) {
        showRequestSentModal.value = true;
        requestSentModalShown.value = true;
      }
    });
    
    // Start/stop polling based on workflowStage
    watch(shouldPollStatus, (needsPolling) => {
      // Clear existing interval
      if (statusPollInterval.value) {
        clearInterval(statusPollInterval.value);
        statusPollInterval.value = null;
      }
      
      // Start polling if needed
      if (needsPolling) {
        statusPollInterval.value = setInterval(() => {
          updateContextualTip();
        }, 5000); // Poll every 5 seconds when needed (faster than 30s for async operations)
      }
    }, { immediate: true });
  } else {
    contextualTip.value = 'Ready to chat';
    loadDeepLinkChat();
    initialLoadComplete.value = true;
  }

  nextTick(() => {
    const snapshot = currentChatSnapshot.value;
    lastLocalSaveSnapshot.value = snapshot;
    lastGroupSaveSnapshot.value = snapshot;
  });

  if (deepLinkShareId.value) {
    loadDeepLinkChat(true);
  }
  
  // Check for pending Current Medications edit deep link
  // This should work whether user is already authenticated or needs to authenticate
  const pendingEdit = sessionStorage.getItem('pendingMedicationsEdit');
  if (pendingEdit && props.user?.userId) {
    try {
      const editData = JSON.parse(pendingEdit);
      if (editData.token && editData.userId === props.user.userId) {
        // Verify token
        const verifyResponse = await fetch(`/api/verify-medications-token?token=${encodeURIComponent(editData.token)}&userId=${encodeURIComponent(editData.userId)}`, {
          credentials: 'include'
        });
        
        if (verifyResponse.ok) {
          const verifyResult = await verifyResponse.json();
          if (verifyResult.valid && !verifyResult.expired) {
            // Token is valid - open My Stuff dialog with Lists tab and auto-edit
            // Use nextTick to ensure dialog is ready
            await nextTick();
            myStuffInitialTab.value = 'lists';
            showMyStuffDialog.value = true;
            // Store flag to auto-edit medications in Lists component
            sessionStorage.setItem('autoEditMedications', 'true');
            // Clear the pending edit from sessionStorage
            sessionStorage.removeItem('pendingMedicationsEdit');
          } else {
            // Token invalid or expired - clear it
            sessionStorage.removeItem('pendingMedicationsEdit');
            if (verifyResult.expired) {
              console.warn('Current Medications edit token has expired');
            } else {
              console.warn('Current Medications edit token is invalid');
            }
          }
        } else {
          console.error('Failed to verify medications token:', verifyResponse.status);
          sessionStorage.removeItem('pendingMedicationsEdit');
        }
      } else {
        // Token or userId mismatch - clear it
        sessionStorage.removeItem('pendingMedicationsEdit');
      }
    } catch (err) {
      console.error('Error processing pending medications edit:', err);
      sessionStorage.removeItem('pendingMedicationsEdit');
    }
  }

  // On load/reload: if agent + files but no KB indexed, show needs-indexing prompt after a short delay
  if (!isDeepLink.value && props.user?.userId) {
    setTimeout(() => checkAndShowNeedsIndexingPrompt(), 1200);
  }

  // Preload Saved Files so page-## links in AI responses can be direct links (not just chooser)
  if (canAccessMyStuff.value && props.user?.userId && availableUserFiles.value.length === 0) {
    loadUserFilesForChooser(false);
  }
});

// Cleanup on unmount (must be at top level, not inside onMounted)
onUnmounted(() => {
  if (statusPollInterval.value) {
    clearInterval(statusPollInterval.value);
    statusPollInterval.value = null;
  }
  if (stage3IndexingPoll.value) {
    clearInterval(stage3IndexingPoll.value);
    stage3IndexingPoll.value = null;
  }
  stopStage3ElapsedTimer();
});
</script>

<style scoped>
.chat-interface {
  width: 100%;
  height: 100vh;
}

.chat-interface .q-card {
  height: 100%;
}

.wizard-slide-scroll {
  max-height: 70vh;
  overflow-y: auto;
}

.wizard-slide-box {
  border: 1px solid #e0e0e0;
  border-top: none !important;
  border-radius: 8px;
  padding: 16px;
  background: #fafafa;
  width: 100%;
  max-width: 720px;
  margin-top: 10px;
}

.wizard-slide-intro {
  max-width: 720px;
  margin-left: 0;
  padding-left: 0;
  border: 0;
  border-bottom: 0 !important;
  box-shadow: none;
}

.wizard-slide-intro {
  text-align: left;
  align-self: flex-start;
}

.wizard-slide-intro hr {
  display: none;
}

.wizard-slide-intro ul,
.wizard-slide-intro li,
.wizard-slide-intro p {
  border: 0 !important;
  box-shadow: none !important;
  background: transparent;
}

.wizard-slide-list {
  margin: 0;
}

.wizard-slide-intro {
  text-align: left;
}

.wizard-slide-item {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
}

.wizard-slide-box-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.wizard-status-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.wizard-medications-not-verified-outline {
  outline: 2px solid var(--q-color-orange-8, #e65100);
  outline-offset: 2px;
}

.wizard-index-now-highlight {
  outline: 2px solid var(--q-color-negative, #c62828);
  outline-offset: 2px;
}

.wizard-verify-btn.q-btn--disabled {
  opacity: 0.3;
}

.wizard-slide-text {
  font-size: 1rem;
  line-height: 1.5;
}

.wizard-slide-image {
  display: block;
  width: 100%;
  height: auto;
  max-height: 70vh;
  object-fit: contain;
}

.wizard-slide-footer {
  padding-top: 0;
}

.wizard-page-dots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
}

.wizard-page-dots--inline {
  justify-content: flex-start;
  margin-left: 30px;
  width: auto;
  display: inline-flex;
  vertical-align: middle;
}

.wizard-page-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  border: 1px solid #9e9e9e;
  background: transparent;
  padding: 0;
  cursor: pointer;
}

.wizard-page-dot--active {
  width: 12px;
  height: 12px;
  border-width: 2px;
  border-color: #5c6bc0;
}

.chat-messages {
  background-color: #fafafa;
}

.edit-buttons {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.message-preview {
  background: #f8f9fa;
  border: 1px solid #dee2e6;
  border-radius: 4px;
  padding: 10px;
  margin: 10px 0;
}

.message-content {
  margin-top: 5px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.wizard-status-line {
  margin-top: 0;
  line-height: 1.1;
  padding-left: 4px;
}

.wizard-status-file {
  margin-top: 0;
}

.wizard-restore-chip {
  margin-right: 6px;
}

.wizard-status-file + .wizard-status-file {
  margin-top: 2px;
}

.wizard-stage-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  column-gap: 8px;
  align-items: flex-start;
}

.wizard-stage-row + .wizard-stage-row {
  margin-top: 6px;
}

.wizard-stage-col1 {
  width: 32px;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding-top: 0;
  position: relative;
}

.wizard-stage-col1 :deep(.q-checkbox) {
  margin-top: -7px;
  align-self: flex-start;
  line-height: 1;
}

.wizard-stage-col1 :deep(.q-checkbox__inner) {
  margin-top: 0;
}

.wizard-stage-col1 :deep(.q-checkbox__label) {
  margin-top: 0;
}

.wizard-stage-text {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.wizard-stage-label {
  padding-left: 4px;
  line-height: 1.2;
}

.wizard-stage-actions {
  display: flex;
  justify-content: flex-end;
}

.wizard-stage-actions-group {
  display: flex;
  gap: 8px;
}

.wizard-index-btn {
  border: 2px solid var(--q-negative) !important;
}

.wizard-stage3-status {
  font-weight: 600;
  color: var(--q-positive) !important;
}

.wizard-no-device-btn {
  margin-right: 15px;
}

.wizard-heading {
  padding-left: 0;
}

.page-link {
  color: #1976d2;
  text-decoration: underline;
  cursor: pointer;
  font-weight: 500;
}

.page-link:hover {
  color: #1565c0;
  text-decoration: underline;
}
</style>

