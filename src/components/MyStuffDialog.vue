<template>
  <q-dialog v-model="isOpen" persistent>
    <q-card style="width: 90vw; height: 90vh; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column;">
      <q-card-section class="row items-center q-pb-none" style="flex-shrink: 0;">
        <div class="text-h5">My Stuff</div>
        <q-space />
        <q-btn icon="close" flat round dense @click="closeDialog" />
      </q-card-section>

      <q-card-section style="flex: 1; overflow-y: auto; min-height: 0;">
        <q-tabs 
          v-model="currentTab" 
          class="text-grey bg-grey-3 rounded-borders"
          active-color="primary" 
          indicator-color="primary" 
          align="justify" 
          style="flex-shrink: 0;"
          dense
        >
          <q-tab name="files" label="Saved Files" icon="description" />
          <q-tab name="agent" label="My AI Agent" icon="smart_toy" />
          <q-tab name="chats" label="Saved Chats" icon="chat" />
          <q-tab name="summary" label="Patient Summary" icon="description" />
          <q-tab name="lists" label="My Lists" icon="list" />
          <q-tab name="privacy" label="Privacy Filter" icon="privacy_tip" />
          <q-tab name="diary" label="Patient Diary" icon="book" />
          <q-tab name="references" label="REFERENCES" icon="link" />
        </q-tabs>

        <q-tab-panels v-model="currentTab" animated>
          <!-- Saved Files Tab -->
          <q-tab-panel name="files">
            <div v-if="loadingFiles" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading files...</div>
            </div>

            <div v-else-if="filesError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ filesError }}</div>
              <q-btn label="Retry" color="primary" @click="loadFiles" class="q-mt-md" />
            </div>

            <div
              v-else-if="userFiles.length === 0 && props.rehydrationActive && rehydrationQueue.length > 0"
              class="q-mt-md"
            >
              <div
                class="q-mb-md q-pa-md"
                style="border: 1px dashed #b0bec5; border-radius: 6px; background: #f7f9fb;"
              >
                <div class="text-subtitle2">Restore your files</div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  Please upload each file to rebuild your Spaces folder.
                </div>
                <div class="q-mt-sm text-body2">
                  Next file: <strong>{{ rehydrationCurrent ? (rehydrationCurrent.fileName || rehydrationCurrent.bucketKey) : 'All done' }}</strong>
                  <span v-if="rehydrationStep === 0" class="q-ml-sm text-grey-7">(initial file)</span>
                </div>
                <div class="q-mt-md">
                  <q-btn
                    color="primary"
                    label="Upload Next File"
                    :disable="rehydrationUploading || !rehydrationCurrent"
                    @click="triggerRehydrationInput"
                  />
                  <span class="q-ml-sm text-caption text-grey-7">
                    {{ rehydrationCompleted.size }} / {{ rehydrationQueue.length }} uploaded
                  </span>
                </div>
                <div v-if="rehydrationDisplayList.length > 0" class="q-mt-sm">
                  <div
                    v-for="entry in rehydrationDisplayList"
                    :key="entry.bucketKey || entry.fileName"
                    class="row items-center q-mt-xs"
                  >
                    <div class="col text-caption text-grey-7">
                      {{ entry.displayName }}
                    </div>
                    <q-chip
                      v-if="!entry.restored"
                      color="red-5"
                      text-color="white"
                      size="sm"
                    >
                      Please re-import this file
                    </q-chip>
                    <q-chip
                      v-else
                      color="green-5"
                      text-color="white"
                      size="sm"
                    >
                      Restored
                    </q-chip>
                    <span class="q-ml-sm text-caption text-grey-7">
                      {{ entry.chipStatus || 'unknown' }}
                    </span>
                  </div>
                </div>
                <input
                  ref="rehydrationInput"
                  type="file"
                  style="display: none;"
                  @change="handleRehydrationFileSelected"
                />
              </div>
            </div>

            <div v-else-if="userFiles.length === 0" class="text-center q-pa-md text-grey">
              <q-icon name="folder_open" size="3em" />
              <div class="q-mt-sm">No files found</div>
            </div>

            <div v-else class="q-mt-md">
              <div
                v-if="props.rehydrationActive && rehydrationQueue.length > 0"
                class="q-mb-md q-pa-md"
                style="border: 1px dashed #b0bec5; border-radius: 6px; background: #f7f9fb;"
              >
                <div class="text-subtitle2">Restore your files</div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  Please upload each file to rebuild your Spaces folder.
                </div>
                <div class="q-mt-sm text-body2">
                  Next file: <strong>{{ rehydrationCurrent ? (rehydrationCurrent.fileName || rehydrationCurrent.bucketKey) : 'All done' }}</strong>
                  <span v-if="rehydrationStep === 0" class="q-ml-sm text-grey-7">(initial file)</span>
                </div>
                <div class="q-mt-md">
                  <q-btn
                    color="primary"
                    label="Upload Next File"
                    :disable="rehydrationUploading || !rehydrationCurrent"
                    @click="triggerRehydrationInput"
                  />
                  <span class="q-ml-sm text-caption text-grey-7">
                    {{ rehydrationCompleted.size }} / {{ rehydrationQueue.length }} uploaded
                  </span>
                </div>
                <div v-if="rehydrationDisplayList.length > 0" class="q-mt-sm">
                  <div
                    v-for="entry in rehydrationDisplayList"
                    :key="entry.bucketKey || entry.fileName"
                    class="row items-center q-mt-xs"
                  >
                    <div class="col text-caption text-grey-7">
                      {{ entry.displayName }}
                    </div>
                    <q-chip
                      v-if="!entry.restored"
                      color="red-5"
                      text-color="white"
                      size="sm"
                    >
                      Please re-import this file
                    </q-chip>
                    <q-chip
                      v-else
                      color="green-5"
                      text-color="white"
                      size="sm"
                    >
                      Restored
                    </q-chip>
                    <span class="q-ml-sm text-caption text-grey-7">
                      {{ entry.chipStatus || 'unknown' }}
                    </span>
                  </div>
                </div>
                <input
                  ref="rehydrationInput"
                  type="file"
                  style="display: none;"
                  @change="handleRehydrationFileSelected"
                />
              </div>
              <q-list>
                <q-item v-for="file in userFiles" :key="file.bucketKey" class="q-pa-md">
                  <q-item-section avatar>
                    <div class="row items-center q-gutter-xs">
                      <q-checkbox
                        :model-value="file.inKnowledgeBase"
                        @click.stop="toggleKbCheckbox(file)"
                        :disable="updatingFiles.has(file.bucketKey) || indexingKB"
                        :color="file.pendingKbAdd ? 'grey-6' : 'primary'"
                      />
                      <q-spinner
                        v-if="updatingFiles.has(file.bucketKey)"
                        size="20px"
                        color="primary"
                      />
                    </div>
                  </q-item-section>
                  <q-item-section>
                    <q-item-label 
                      class="cursor-pointer text-primary"
                      @click="viewFileInPdfViewer(file)"
                    >
                      {{ file.fileName }}
                      <q-chip
                        v-if="file.isAppleHealth"
                        color="blue-6"
                        text-color="white"
                        size="sm"
                        dense
                        class="q-ml-xs"
                      >
                        Apple Health
                      </q-chip>
                    </q-item-label>
                    <q-item-label caption>
                      {{ formatFileSize(file.fileSize) }} • Uploaded {{ formatDate(file.uploadedAt) }}
                      <span v-if="updatingFiles.has(file.bucketKey)" class="q-ml-sm text-primary">
                        Moving file...
                      </span>
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side>
                    <div class="row items-center q-gutter-xs">
                      <!-- Pending from wizard - show gray "To be added and indexed" -->
                      <q-chip
                        v-if="file.pendingKbAdd"
                        color="grey-4"
                        text-color="grey-8"
                        size="sm"
                      >
                        To be added and indexed
                      </q-chip>
                      <!-- Not in KB - show amber "Add to Knowledge Base" -->
                      <q-chip
                        v-else-if="!file.inKnowledgeBase"
                        color="amber"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = true; onCheckboxChange(file)"
                      >
                        Add to Knowledge Base
                      </q-chip>
                      <!-- In KB but not indexed - show warning "To be added and indexed" -->
                      <q-chip
                        v-else-if="file.inKnowledgeBase && !isFileIndexed(file.bucketKey)"
                        color="orange"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = false; onCheckboxChange(file)"
                      >
                        To be added and indexed
                      </q-chip>
                      <!-- In KB and indexed - show primary "Indexed in Knowledge Base" -->
                      <q-chip
                        v-else
                        color="primary"
                        text-color="white"
                        size="sm"
                        clickable
                        @click="file.inKnowledgeBase = false; onCheckboxChange(file)"
                      >
                        Indexed in Knowledge Base
                      </q-chip>
                      <q-btn
                        flat
                        round
                        dense
                        icon="delete"
                        color="negative"
                        @click="confirmDeleteFile(file)"
                        title="Delete file"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </q-list>

              <div
                v-if="kbSummaryTokens !== null && kbSummaryFiles !== null"
                class="q-mt-sm text-caption text-grey-7"
              >
                Your Private AI current knowledge base has a total {{ formatNumber(kbSummaryTokens) }} tokens from
                {{ formatNumber(kbSummaryFiles) }} indexed files
                <span v-if="kbDataSourceCount !== null">
                  ({{ formatNumber(kbDataSourceCount) }} data sources)
                </span>.
              </div>
              
              <div v-if="kbNeedsUpdate || hasCheckboxChanges || kbIndexingOutOfSync || hasPendingKbAdds" class="q-mt-md q-pt-md" style="border-top: 1px solid #e0e0e0;">
                <div v-if="kbNeedsUpdate || hasCheckboxChanges || hasPendingKbAdds" class="q-mb-md text-body2 text-amber-9">
                  You have changed the files to be indexed into your knowledge base. Click "Update and Index KB" when ready.
                </div>
                <div v-else-if="kbIndexingOutOfSync && !hasCheckboxChanges && !hasPendingKbAdds" class="q-mb-md text-body2 text-amber-9">
                  You have changed the files to be indexed into your knowledge base. Click to index when ready.
                </div>
                <div class="row q-gutter-sm">
                <q-btn
                  label="Update and Index KB"
                  color="primary"
                  @click="updateAndIndexKB"
                    :disable="indexingKB"
                  :loading="indexingKB"
                />
                </div>
              </div>
              
              <!-- Phase 1: Moving files -->
              <div v-if="indexingKB && indexingStatus.phase === 'moving'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Moving files to knowledge base folder...' }}</div>
              </div>

              <!-- Phase 2: KB Setup -->
              <div v-if="indexingKB && indexingStatus.phase === 'kb_setup'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Setting up knowledge base...' }}</div>
                <div v-if="indexingStatus.kb" class="text-caption text-grey-7 q-mt-xs">KB: {{ indexingStatus.kb }}</div>
              </div>

              <!-- Phase 3: Indexing Started -->
              <div v-if="indexingKB && indexingStatus.phase === 'indexing_started'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress indeterminate color="primary" class="q-mb-sm" />
                <div class="text-body2">{{ indexingStatus.message || 'Indexing job started...' }}</div>
                <div class="text-caption text-grey-7 q-mt-xs">This may take several minutes</div>
              </div>

              <!-- Phase 4: Indexing In Progress -->
              <div v-if="indexingKB && indexingStatus.phase === 'indexing'" class="q-mt-md q-pa-md" style="background-color: #f5f5f5; border-radius: 4px;">
                <q-linear-progress 
                  :value="indexingStatus.progress || 0" 
                  color="primary" 
                  animated
                  class="q-mb-sm"
                />
                <div class="text-body2">Indexing in progress...</div>
                <div v-if="indexingStatus.message" class="text-caption text-grey-7 q-mt-xs">
                  {{ indexingStatus.message }}
                </div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  <span v-if="indexingStatus.kb">KB: {{ indexingStatus.kb }} • </span>
                  <span v-if="indexingElapsedTime">Time: {{ indexingElapsedTime }} • </span>
                  Files: {{ indexingStatus.filesIndexed || 0 }} • 
                  Tokens: {{ indexingStatus.tokens || 'Calculating...' }}
                </div>
                <div class="text-caption text-grey-6 q-mt-xs">
                  This may take up to 60 minutes.
                </div>
              </div>

              <!-- Phase 5: Complete -->
              <div v-if="indexingKB && indexingStatus.phase === 'complete'" class="q-mt-md q-pa-md" style="background-color: #e8f5e9; border-radius: 4px; border: 1px solid #4caf50;">
                <div class="text-body2 text-positive">
                  ✅ {{ indexingStatus.message || 'Knowledge base indexed successfully!' }}
                </div>
                <div class="text-caption text-grey-7 q-mt-xs">
                  <span v-if="indexingStatus.kb">KB: {{ indexingStatus.kb }} • </span>
                  Tokens: {{ indexingStatus.tokens }} • 
                  Files: {{ indexingStatus.filesIndexed }}
                </div>
              </div>

              <!-- Phase 6: Error -->
              <div v-if="indexingKB && indexingStatus.phase === 'error'" class="q-mt-md q-pa-md" style="background-color: #ffebee; border-radius: 4px; border: 1px solid #f44336;">
                <div class="text-body2 text-negative">
                  ❌ {{ indexingStatus.error || 'Indexing failed' }}
                </div>
                <div v-if="indexingStatus.kb" class="text-caption text-grey-7 q-mt-xs">KB: {{ indexingStatus.kb }}</div>
              </div>
            </div>
          </q-tab-panel>

          <!-- My AI Agent Tab -->
          <q-tab-panel name="agent">
            <div class="row items-center justify-between q-mb-md">
              <div class="text-h6">Agent Instructions</div>
              <q-btn
                label="EDIT"
                color="primary"
                @click="editMode = !editMode"
                :icon="editMode ? 'close' : 'edit'"
              />
            </div>

            <!-- Deep link Private AI access switch -->
            <div class="row items-center justify-center q-mb-md">
              <q-toggle
                v-model="allowDeepLinkPrivateAI"
                label="Deep link users can chat with your Private AI"
                color="primary"
                :loading="savingDeepLinkSetting"
                @update:model-value="saveDeepLinkPrivateAISetting"
              />
            </div>

            <div v-if="loadingAgent" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading agent...</div>
            </div>

            <div v-else-if="agentError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ agentError }}</div>
              <q-btn label="Retry" color="primary" @click="loadAgent" class="q-mt-md" />
            </div>

            <div v-else-if="agentInstructions">
              <div v-if="editMode" class="q-mb-md">
                <q-input
                  v-model="editedInstructions"
                  type="textarea"
                  rows="15"
                  outlined
                  autofocus
                />
                <div class="q-mt-md">
                  <q-btn label="Save" color="primary" @click="saveInstructions" :loading="savingInstructions" />
                  <q-btn label="Cancel" flat @click="cancelEdit" class="q-ml-sm" />
                </div>
              </div>

              <div v-else>
                <div class="q-mb-md">
                  <vue-markdown :source="agentInstructions" />
                </div>
              </div>

              <!-- Agent Knowledge Base Section -->
              <div v-if="kbInfo" class="q-mt-lg" style="border-top: 1px solid #e0e0e0; padding-top: 16px;">
                <div class="text-h6 q-mb-md">Agent Knowledge Base</div>
                
                <div class="row items-center q-mb-sm">
                  <div class="col">
                    <div class="text-weight-medium">{{ kbInfo.name }}</div>
                    <div class="text-caption text-grey-7 q-mt-xs">
                      Last indexed: {{ formatRelativeTime(kbInfo.lastIndexedAt || null) }}
                    </div>
                  </div>
                  <div class="col-auto">
                    <q-chip
                      :color="kbInfo.connected ? 'green' : 'amber'"
                      text-color="white"
                      :label="kbInfo.connected ? 'Connected' : 'Not Connected'"
                      clickable
                      @click="toggleKBConnection"
                      :disable="togglingKB"
                      :loading="togglingKB"
                    />
                  </div>
                </div>
                
                <div class="q-mt-md">
                  <div class="text-caption text-grey-7 q-mb-xs">Indexed Files:</div>
                  <div 
                    v-if="indexedFileNames.length === 0"
                    class="text-caption text-grey-5"
                  >
                    No files indexed yet
                  </div>
                  <q-list
                    v-else
                    dense
                    :class="{ 'text-grey-5': !kbInfo.connected }"
                  >
                    <q-item
                      v-for="(fileName, index) in indexedFileNames"
                      :key="index"
                      dense
                    >
                      <q-item-section>
                        <q-item-label 
                          :class="{ 'text-grey-5': !kbInfo.connected }"
                          class="text-caption"
                        >
                          {{ fileName }}
                        </q-item-label>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
              </div>

              <div v-else-if="!loadingAgent" class="q-mt-lg text-center text-grey-7">
                <div class="text-caption">No knowledge base configured</div>
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="smart_toy" size="3em" />
              <div class="q-mt-sm">No agent found</div>
            </div>
          </q-tab-panel>

          <!-- Saved Chats Tab -->
          <q-tab-panel name="chats">
            <div v-if="loadingChats" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading chats...</div>
            </div>

            <div v-else-if="chatsError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ chatsError }}</div>
              <q-btn label="Retry" color="primary" @click="loadSharedChats" class="q-mt-md" />
            </div>

            <div v-else-if="sharedChats.length === 0" class="text-center q-pa-md text-grey">
              <q-icon name="chat" size="3em" />
              <div class="q-mt-sm">No shared group chats found</div>
            </div>

            <div v-else class="q-mt-md">
              <q-list>
                <q-item
                  v-for="chat in sortedSharedChats"
                  :key="chat._id"
                  clickable
                  class="q-pa-md q-mb-sm"
                  style="border: 1px solid #e0e0e0; border-radius: 8px;"
                  @click="selectChat(chat)"
                >
                  <q-item-section>
                    <q-item-label class="text-weight-medium">
                      {{ formatDate(chat.updatedAt || chat.createdAt) }}
                    </q-item-label>
                    <q-item-label caption class="q-mt-xs">
                      {{ getLastQueryDescription(chat) }}
                    </q-item-label>
                    <q-item-label caption class="q-mt-xs">
                      Group Participants: {{ getGroupParticipants(chat) }}
                    </q-item-label>
                    <q-item-label v-if="chat.shareId" caption class="q-mt-xs text-primary">
                      <q-icon name="link" size="xs" />
                      Deep link: /chat/{{ chat.shareId }}
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side @click.stop>
                    <div class="row items-center q-gutter-xs">
                      <q-btn
                        flat
                        round
                        dense
                        icon="link"
                        color="primary"
                        @click="copyChatLink(chat)"
                        title="Copy deep link"
                      />
                      <q-btn
                        flat
                        round
                        dense
                        icon="delete"
                        color="negative"
                        @click="confirmDeleteChat(chat)"
                        title="Delete chat"
                      />
                    </div>
                  </q-item-section>
                </q-item>
              </q-list>
            </div>
          </q-tab-panel>

          <!-- My Lists Tab -->
          <q-tab-panel name="lists">
            <Lists
              ref="listsComponentRef"
              :userId="userId"
              @back-to-chat="closeDialog"
              @show-patient-summary="handleShowPatientSummary"
              @current-medications-saved="handleCurrentMedicationsSaved"
            />
          </q-tab-panel>

          <!-- Privacy Filter Tab -->
          <q-tab-panel name="privacy">
            <!-- Filter Current Chat Button -->
            <div class="q-pa-md" style="border-bottom: 1px solid #eee;">
              <q-btn
                label="Filter Current Chat"
                color="primary"
                icon="filter_alt"
                :disable="!privacyFilterMapping.length || !props.originalMessages || props.originalMessages.length === 0"
                @click="filterCurrentChat"
                class="full-width"
              />
              <div v-if="!privacyFilterMapping.length" class="text-caption text-grey q-mt-xs text-center">
                No pseudonym mapping available
              </div>
              <div v-else-if="!props.originalMessages || props.originalMessages.length === 0" class="text-caption text-grey q-mt-xs text-center">
                No chat messages available
              </div>
            </div>

            <div v-if="loadingPrivacyFilter" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Analyzing chat for names...</div>
            </div>

            <div v-else-if="privacyFilterError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ privacyFilterError }}</div>
              <q-btn label="Retry" color="primary" @click="loadPrivacyFilter" class="q-mt-md" />
            </div>

            <div v-else-if="privacyFilterMapping.length > 0" class="q-pa-md">
              <div class="text-h6 q-mb-md">Privacy Filter - Name Pseudonymization</div>
              
              <div v-if="loadingRandomNames" class="text-center q-pa-md">
                <q-spinner size="1.5em" />
                <div class="q-mt-sm">Generating pseudonyms...</div>
              </div>
              
              <div v-else class="q-mt-md">
                <div class="text-body2 text-grey q-mb-sm">
                  Showing {{ privacyFilterMapping.length }} name{{ privacyFilterMapping.length !== 1 ? 's' : '' }} in pseudonym mapping
                </div>
                <q-table
                  :rows="privacyFilterMapping"
                  :columns="[
                    { name: 'original', label: 'Original Name', field: 'original', align: 'left' },
                    { name: 'pseudonym', label: 'Pseudonym', field: 'pseudonym', align: 'left' }
                  ]"
                  row-key="original"
                  flat
                  bordered
                  :rows-per-page-options="[0]"
                  hide-pagination
                />
              </div>
            </div>

            <div v-else-if="privacyFilterResponse" class="q-pa-md">
              <div class="text-h6 q-mb-md">Privacy Filter - Name Pseudonymization</div>
              <div class="text-body2 text-grey q-mb-md">No pseudonym mapping available. Original response:</div>
              <div class="privacy-filter-response">
                <vue-markdown :source="privacyFilterResponse" />
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="person_off" size="3em" />
              <div class="q-mt-sm">No mapping available</div>
            </div>
          </q-tab-panel>

          <!-- Patient Diary Tab -->
          <q-tab-panel name="diary" class="q-pa-none" style="display: flex; flex-direction: column; height: 100%;">
            <div v-if="loadingDiary" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading diary...</div>
            </div>

            <div v-else-if="diaryError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ diaryError }}</div>
              <q-btn label="Retry" color="primary" @click="loadDiary" class="q-mt-md" />
            </div>

            <div v-else style="display: flex; flex-direction: column; height: 100%;">
              <!-- Diary Messages Area -->
              <div 
                ref="diaryMessagesRef" 
                class="q-pa-md" 
                style="flex: 1; overflow-y: auto; min-height: 0;"
              >
                <div v-if="diaryEntries.length === 0" class="text-center q-pa-md text-grey">
                  <q-icon name="book" size="3em" />
                  <div class="q-mt-sm">No diary entries yet</div>
                  <div class="text-caption q-mt-xs">Start writing your first entry below</div>
                </div>

                <template v-for="bubble in diaryBubbles" :key="bubble.entries[bubble.entries.length - 1]?.id || bubble.lastDateTime">
                  <div class="q-mb-md" style="position: relative;">
                    <div class="row items-center justify-between q-mb-xs">
                      <div class="text-caption text-grey-7">
                        {{ formatDiaryDateTime(bubble.lastDateTime) }}
                      </div>
                      <div class="row q-gutter-xs">
                        <q-btn
                          flat
                          dense
                          size="sm"
                          icon="send"
                          color="primary"
                          label="Post diary to chat"
                          @click="postBubbleToChat(bubble)"
                        />
                        <q-btn
                          flat
                          dense
                          round
                          size="sm"
                          icon="delete"
                          color="negative"
                          @click="deleteBubble(bubble)"
                          title="Delete bubble"
                        />
                      </div>
                    </div>
                    <div 
                      class="q-pa-md bg-blue-1 rounded-borders"
                      style="display: inline-block; max-width: 80%;"
                      :class="{ 'opacity-60': bubble.closed }"
                    >
                      <div
                        v-for="(entry, entryIdx) in bubble.entries" 
                        :key="entry.id || entryIdx"
                        class="text-body1"
                        :class="{ 'q-mb-sm': entryIdx < bubble.entries.length - 1 }"
                        style="white-space: pre-wrap;"
                      >
                        <span class="text-grey-7 text-caption">{{ formatDiaryTime(entry.dateTime) }}</span> {{ entry.message }}
                      </div>
                    </div>
                  </div>
                </template>
              </div>

              <!-- Text Input Area -->
              <div class="q-pa-md" style="flex-shrink: 0; border-top: 1px solid #eee;">
                <q-input
                  v-model="diaryInputText"
                  type="textarea"
                  autogrow
                  filled
                  placeholder="Write your diary entry..."
                  :disable="isSavingDiary"
                  @keydown.enter.ctrl="addDiaryEntry"
                  @keydown.enter.meta="addDiaryEntry"
                  class="q-mb-sm"
                />
                <div class="row justify-end">
                  <q-btn
                    label="Add Entry"
                    color="primary"
                    icon="send"
                    @click="addDiaryEntry"
                    :loading="isSavingDiary"
                    :disable="!diaryInputText.trim() || isSavingDiary"
                  />
                </div>
              </div>
            </div>
          </q-tab-panel>

          <!-- SHARED REFERENCES Tab -->
          <q-tab-panel name="references" class="q-pa-none" style="display: flex; flex-direction: column; height: 100%;">
            <div v-if="loadingReferences" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading references...</div>
            </div>

            <div v-else-if="referencesError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ referencesError }}</div>
              <q-btn label="Retry" color="primary" @click="loadReferences" class="q-mt-md" />
            </div>

            <div v-else style="display: flex; flex-direction: column; height: 100%;">
              <!-- Header with paperclip -->
              <div class="q-pa-md" style="flex-shrink: 0; border-bottom: 1px solid #eee;">
                <div class="row items-center justify-between">
                  <div class="text-h6">Shared References</div>
                  <q-btn 
                    flat 
                    dense 
                    round 
                    icon="attach_file" 
                    class="text-grey-6" 
                    @click="triggerReferenceFileInput"
                    title="Upload reference file"
                  >
                    <q-tooltip>Upload a reference file</q-tooltip>
                  </q-btn>
                  <input
                    ref="referenceFileInput"
                    type="file"
                    style="display: none"
                    @change="handleReferenceFileSelect"
                    accept=".pdf,.txt,.md"
                  />
                </div>
              </div>

              <!-- References List -->
              <div class="q-pa-md" style="flex: 1; overflow-y: auto; min-height: 0;">
                <div v-if="referenceFiles.length === 0" class="text-center q-pa-md text-grey">
                  <q-icon name="link" size="3em" />
                  <div class="q-mt-sm">No reference files yet</div>
                  <div class="text-caption q-mt-xs">Use the paperclip icon to upload reference files</div>
                </div>

                <q-list v-else>
                  <q-item 
                    v-for="file in referenceFiles" 
                    :key="file.bucketKey" 
                    class="q-pa-md"
                    clickable
                    @click="showAddReferenceToChatDialog(file)"
                  >
                    <q-item-section avatar>
                      <q-icon name="description" size="2em" color="primary" />
                    </q-item-section>
                    <q-item-section>
                      <q-item-label>{{ file.fileName }}</q-item-label>
                      <q-item-label caption>
                        {{ formatFileSize(file.fileSize) }} • Uploaded {{ formatDate(file.uploadedAt) }}
                      </q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <div class="row items-center q-gutter-xs">
                        <q-btn 
                          flat 
                          dense 
                          round 
                          size="sm"
                          icon="visibility" 
                          color="primary"
                          @click.stop="viewReferenceFile(file)"
                          title="View file"
                        />
                        <q-btn 
                          flat 
                          dense 
                          round 
                          size="sm"
                          icon="delete" 
                          color="negative"
                          @click.stop="deleteReferenceFile(file)"
                          title="Delete file"
                        />
                      </div>
                    </q-item-section>
                  </q-item>
                </q-list>
              </div>
            </div>
          </q-tab-panel>

          <!-- Patient Summary Tab -->
          <q-tab-panel name="summary">
            <div v-if="loadingSummary" class="text-center q-pa-md">
              <q-spinner size="2em" />
              <div class="q-mt-sm">Loading patient summary...</div>
            </div>

            <div v-else-if="summaryError" class="text-center q-pa-md">
              <q-icon name="error" color="negative" size="40px" />
              <div class="text-negative q-mt-sm">{{ summaryError }}</div>
              <q-btn label="Retry" color="primary" @click="loadPatientSummary" class="q-mt-md" />
            </div>

            <div v-else-if="patientSummary" class="q-mt-md">
              <div class="row items-center justify-between q-gutter-sm q-mb-sm">
                <div class="text-caption text-grey-7">
                  <!-- Patient summary editing -->
              </div>
                <div class="row q-gutter-sm">
                  <q-btn
                    v-if="showSummaryAttention && !isEditingSummaryTab"
                    outline
                    label="Verify"
                    color="primary"
                    icon="verified"
                    :class="{ 'verify-highlight': showSummaryAttention }"
                    @click="handleVerifySummaryTab"
                  />
                  <q-btn
                    v-if="!isEditingSummaryTab"
                    outline
                    label="Edit"
                    color="primary"
                    icon="edit"
                    :class="{ 'verify-highlight': showSummaryAttention }"
                    @click="startSummaryEdit"
                  />
                  <q-btn
                    v-else
                    flat
                    label="Cancel"
                    color="grey-8"
                    icon="close"
                    @click="cancelSummaryEdit"
                    :disable="isSavingSummary"
                  />
                </div>
              </div>

              <div v-if="isEditingSummaryTab">
                <q-input
                  v-model="summaryEditText"
                  type="textarea"
                  autogrow
                  filled
                  class="bg-grey-1 rounded-borders"
                  :disable="isSavingSummary"
                  placeholder="Enter patient summary..."
                />
              </div>
              <div v-else class="text-body1 q-pa-md bg-grey-1 rounded-borders">
                <vue-markdown :source="patientSummary" />
              </div>

              <div class="row items-center q-gutter-sm q-mt-md">
                <q-btn
                  v-if="isEditingSummaryTab"
                  label="Save"
                  color="primary"
                  icon="save"
                  @click="saveSummaryFromTab"
                  :loading="isSavingSummary"
                  :disable="isSavingSummary"
                />
                <!-- Buttons for non-current summaries -->
                <template v-for="(summary, index) in patientSummaries" :key="index">
                  <q-btn
                    v-if="!summary.isCurrent && !isEditingSummaryTab"
                    outline
                    :label="`SUMMARY ${getTimeAgo(summary.updatedAt || summary.createdAt)} ago`"
                    color="grey-7"
                    size="sm"
                    @click="swapSummary(index)"
                    :disable="isSavingSummary"
                  />
                </template>
                <q-space />
                <q-btn 
                  label="Request New Summary" 
                  color="primary" 
                  @click="requestNewSummary"
                  icon="refresh"
                  :disable="isEditingSummaryTab || isSavingSummary"
                  :loading="loadingSummary"
                />
              </div>
            </div>

            <div v-else class="text-center q-pa-md text-grey">
              <q-icon name="description" size="3em" />
              <div class="q-mt-sm">No patient summary found</div>
              <div class="q-mt-md">
                <q-btn 
                  label="Request Summary" 
                  color="primary" 
                  @click="requestNewSummary"
                  icon="add"
                />
              </div>
            </div>
          </q-tab-panel>
        </q-tab-panels>
      </q-card-section>
    </q-card>
    
    <!-- PDF Viewer Modal -->
    <PdfViewerModal
      v-model="showPdfViewer"
      :file="viewingFile"
    />

    <!-- Text/Markdown Viewer Modal -->
    <TextViewerModal
      v-model="showTextViewer"
      :file="viewingFile"
    />

    <!-- Patient Summary Available Modal (used both before and after generation) -->
    <q-dialog v-model="showSummaryAvailableModal" persistent>
      <q-card style="min-width: 400px; max-width: 600px;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">
            {{ isSummaryModalBeforeGeneration ? 'Replace Existing Summary?' : 'New Patient Summary Available' }}
          </div>
        </q-card-section>

        <q-card-section>
          <div class="text-body1">
            {{ isSummaryModalBeforeGeneration 
              ? 'A patient summary already exists. Generating a new summary will replace the current one. Do you want to continue?'
              : 'A new patient summary has been generated based on your updated knowledge base.' }}
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <q-btn 
            flat 
            :label="isSummaryModalBeforeGeneration 
              ? 'CANCEL' 
              : (patientSummary ? 'KEEP SAVED SUMMARY' : 'CLOSE MyStuff')" 
            color="grey-8" 
            @click="handleCloseSummaryModal"
          />
          <q-btn 
            flat 
            label="REPLACE SUMMARY" 
            color="primary" 
            @click="isSummaryModalBeforeGeneration ? handleConfirmReplaceSummary() : handleSaveSummary()"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Patient Summary View Modal -->
    <q-dialog v-model="showSummaryViewModal" persistent>
      <q-card style="min-width: 600px; max-width: 900px; max-height: 80vh;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Patient Summary</div>
          <q-space />
          <q-btn icon="close" flat round dense @click="handleCloseWithoutSaving" />
        </q-card-section>

        <q-card-section style="max-height: 60vh; overflow-y: auto;">
          <div v-if="!editingSummary" class="text-body2">
            <vue-markdown :source="summaryViewText" />
          </div>
          <q-input
            v-else
            v-model="summaryViewText"
            type="textarea"
            autofocus
            rows="20"
            filled
            style="width: 100%;"
          />
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <q-btn
            v-if="showSummaryAttention && !editingSummary"
            outline
            label="VERIFY"
            color="primary"
            icon="verified"
            :class="{ 'verify-highlight': showSummaryAttention }"
            @click="handleVerifySummaryTab"
          />
          <q-btn 
            flat 
            label="CLOSE WITHOUT SAVING" 
            color="grey-8" 
            @click="handleCloseWithoutSaving"
          />
          <q-btn 
            v-if="editingSummary"
            label="SAVE" 
            color="primary" 
            @click="handleSaveEditedSummary"
          />
          <q-btn 
            v-else
            label="EDIT" 
            color="primary" 
            @click="handleEditSummary"
            :class="{ 'verify-highlight': showSummaryAttention }"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Replace Summary Dialog (when new summary is created and all slots are full) -->
    <q-dialog v-model="showReplaceSummaryDialog" persistent>
      <q-card style="min-width: 800px; max-width: 1200px; max-height: 90vh;">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">New Patient Summary Generated</div>
        </q-card-section>

        <q-card-section style="max-height: 60vh; overflow-y: auto;">
          <div class="text-body1 q-mb-md">
            A new patient summary has been generated. Choose which summary to replace:
          </div>
          <div class="text-body2 q-pa-md bg-grey-1 rounded-borders">
            <vue-markdown :source="newSummaryToReplace" />
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-pa-md">
          <!-- Buttons for each existing summary (oldest to newest) -->
          <template v-for="(summary, index) in patientSummaries" :key="index">
            <q-btn 
              flat 
              :label="`Replace ${getTimeAgo(summary.updatedAt || summary.createdAt)} ago summary`"
              color="primary" 
              @click="handleReplaceSummaryByIndex(index)"
            />
          </template>
          <q-btn 
            flat 
            label="Close without saving" 
            color="grey-8" 
            @click="showReplaceSummaryDialog = false; newSummaryToReplace = ''"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from 'vue';
import VueMarkdown from 'vue-markdown-render';
import PdfViewerModal from './PdfViewerModal.vue';
import TextViewerModal from './TextViewerModal.vue';
import Lists from './Lists.vue';
import { useQuasar } from 'quasar';
import { deleteChatById } from '../utils/chatApi';

interface UserFile {
  fileName: string;
  bucketKey: string;
  fileSize: number;
  uploadedAt: string;
  inKnowledgeBase: boolean;
  pendingKbAdd?: boolean;
  fileType?: string;
  isAppleHealth?: boolean;
}

interface SavedChat {
  _id: string;
  type: string;
  shareId: string;
  currentUser: string;
  patientOwner?: string;
  chatHistory: any[];
  uploadedFiles: any[];
  createdAt: string;
  updatedAt: string;
  isShared?: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  name?: string;
  authorId?: string;
  authorLabel?: string;
  authorType?: 'user' | 'assistant';
  providerKey?: string;
}

interface Props {
  modelValue: boolean;
  userId: string;
  initialTab?: string;
  messages?: Message[];
  originalMessages?: Message[]; // Original unfiltered messages for privacy filtering
  rehydrationFiles?: Array<{ fileName?: string; bucketKey?: string; fileSize?: number; uploadedAt?: string }>;
  rehydrationActive?: boolean;
  wizardActive?: boolean;
  /** When true and dialog opens on summary tab, trigger one requestNewSummary() then clear (avoids duplicate with wizard). */
  requestSummaryOnOpen?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'files',
  messages: () => [],
  originalMessages: () => [],
  requestSummaryOnOpen: false
});

const emit = defineEmits<{
  'index-now-triggered': [];
  'update:modelValue': [value: boolean];
  'chat-selected': [chat: SavedChat];
  'indexing-started': [data: { jobId: string; phase: string }];
  'indexing-status-update': [data: { jobId: string; phase: string; tokens: string; filesIndexed: number; progress: number }];
  'indexing-finished': [data: { jobId: string; phase: string; error?: string }];
  'files-archived': [archivedFiles: string[]]; // Emit bucketKeys of archived files
  'messages-filtered': [messages: Message[]]; // Emit filtered messages with pseudonyms
  'diary-posted': [content: string]; // Emit diary content to add to chat
  'reference-file-added': [file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string; isReference: boolean }]; // Emit reference file to add to chat
  'current-medications-saved': [data: { value: string; edited: boolean }];
  'patient-summary-saved': [data: { userId: string }];
  'patient-summary-verified': [data: { userId: string }];
  'rehydration-complete': [payload: { hasInitialFile: boolean }];
  'rehydration-file-removed': [payload: { bucketKey?: string; fileName?: string }];
  'request-summary-done': [];
}>();

// Handle show patient summary from Lists component
const handleShowPatientSummary = async () => {
  // Switch to Patient Summary tab
  currentTab.value = 'summary';
  
  // Wait a bit for tab to switch, then trigger new summary generation
  await nextTick();
  setTimeout(() => {
    requestNewSummary();
  }, 300);
};

const handleCurrentMedicationsSaved = (payload: { value: string; edited: boolean }) => {
  emit('current-medications-saved', payload);
};

const isOpen = ref(props.modelValue);
const currentTab = ref(props.initialTab || 'files');
const loadingFiles = ref(false);
const filesError = ref('');
const userFiles = ref<UserFile[]>([]);
const updatingFiles = ref(new Set<string>());

const loadingAgent = ref(false);
const agentError = ref('');
const agentInstructions = ref('');
const editMode = ref(false);
const editedInstructions = ref('');
const savingInstructions = ref(false);

// Deep link Private AI access setting
const allowDeepLinkPrivateAI = ref(true); // Default to enabled
const savingDeepLinkSetting = ref(false);

// KB info for agent tab
const kbInfo = ref<{
  name: string;
  kbId: string;
  connected: boolean;
  indexedDataSourceCount?: number | null;
  lastIndexedAt?: string | null;
} | null>(null);
const togglingKB = ref(false);

const loadingChats = ref(false);
const chatsError = ref('');
const sharedChats = ref<SavedChat[]>([]);

// Patient Summary
const loadingSummary = ref(false);
const summaryError = ref('');

// Privacy Filter
const loadingPrivacyFilter = ref(false);
const privacyFilterError = ref('');
const privacyFilterResponse = ref('');
const privacyFilterMapping = ref<Array<{ original: string; pseudonym: string }>>([]);
const loadingRandomNames = ref(false);
const patientSummary = ref('');
const patientSummaries = ref<Array<{ text: string; createdAt: string; updatedAt: string; isCurrent: boolean }>>([]);

// Patient Diary
const loadingDiary = ref(false);
const diaryError = ref('');
const diaryEntries = ref<Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>>([]);
const diaryInputText = ref('');
const isSavingDiary = ref(false);
const diaryMessagesRef = ref<HTMLElement | null>(null);

// Shared References
const loadingReferences = ref(false);
const referencesError = ref('');
const referenceFiles = ref<Array<{ fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }>>([]);
const referenceFileInput = ref<HTMLInputElement | null>(null);
const isUploadingReference = ref(false);
const selectedReferenceForChat = ref<{ fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string } | null>(null);
const savedCurrentSummaryForUndo = ref<{ text: string; createdAt: string; updatedAt: string } | null>(null);
const showReplaceSummaryDialog = ref(false);
const newSummaryToReplace = ref('');

// PDF Viewer
const showPdfViewer = ref(false);
const showTextViewer = ref(false);
const viewingFile = ref<any>(null);

// KB management
const originalFiles = ref<UserFile[]>([]);
const indexedFiles = ref<string[]>([]); // Track which files are actually indexed
const kbNeedsUpdate = ref(false); // Track if KB needs to be updated (files moved)
const kbSummaryTokens = ref<string | number | null>(null);
const kbSummaryFiles = ref<number | null>(null);
const showWizardSummaryActions = computed(() => !!props.wizardActive && currentTab.value === 'summary');
const summaryNeedsVerify = ref(false);
const showSummaryAttention = computed(() => showWizardSummaryActions.value || summaryNeedsVerify.value);
const kbDataSourceCount = ref<number | null>(null);
const kbIndexedDataSourceCount = ref<number | null>(null);
// Rehydration flow (temporary account restore)
const rehydrationQueue = ref<Array<{ fileName?: string; bucketKey?: string; fileSize?: number; uploadedAt?: string; chipStatus?: string; kbName?: string | null; isInitial?: boolean }>>([]);
const rehydrationCompleted = ref<Set<string>>(new Set());
const rehydrationUploading = ref(false);
const rehydrationInput = ref<HTMLInputElement | null>(null);
const rehydrationStep = ref(0);

const normalizeRehydrationName = (entry: { fileName?: string; bucketKey?: string }) => {
  if (entry.fileName) return entry.fileName;
  const key = entry.bucketKey || '';
  return key.split('/').pop() || key;
};

const rehydrationRemaining = computed(() =>
  rehydrationQueue.value.filter(entry => !rehydrationCompleted.value.has(normalizeRehydrationName(entry)))
);

const rehydrationDisplayList = computed(() => rehydrationQueue.value.map(entry => {
  const name = normalizeRehydrationName(entry);
  return {
    ...entry,
    displayName: entry.fileName || entry.bucketKey || 'Unknown file',
    restored: rehydrationCompleted.value.has(name)
  };
}));

const rehydrationCurrent = computed(() => rehydrationRemaining.value[0] || null);

watch(
  () => props.rehydrationFiles,
  (files) => {
    if (Array.isArray(files) && files.length > 0) {
      rehydrationQueue.value = files;
      rehydrationCompleted.value = new Set();
      rehydrationStep.value = 0;
      console.log('[SAVE-RESTORE] Rehydration queue set', {
        userId: props.userId,
        count: files.length
      });
    } else {
      rehydrationQueue.value = [];
      rehydrationCompleted.value = new Set();
      rehydrationStep.value = 0;
    }
  },
  { immediate: true }
);

const triggerRehydrationInput = () => {
  rehydrationInput.value?.click();
};

const handleRehydrationFileSelected = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = '';
  if (!file || !props.userId) return;

  const currentEntry = rehydrationCurrent.value || null;
  const expected = currentEntry ? normalizeRehydrationName(currentEntry) : null;
  if (!expected) return;

  console.log('[SAVE-RESTORE] Rehydration file selected', {
    userId: props.userId,
    expected,
    selected: file.name
  });

  if (file.name !== expected) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: `Please select the file named "${expected}".`,
        timeout: 4000
      });
    }
    return;
  }

  rehydrationUploading.value = true;
  try {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch('/api/files/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to upload file');
    }
    const uploadResult = await response.json();
    if (uploadResult?.fileInfo) {
      try {
        const isAppleHealth = String(uploadResult.fileInfo.fileName || '').toLowerCase().endsWith('.pdf')
          ? await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey)
          : false;
        await fetch('/api/user-file-metadata', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            fileMetadata: {
              fileName: uploadResult.fileInfo.fileName,
              bucketKey: uploadResult.fileInfo.bucketKey,
              bucketPath: uploadResult.fileInfo.userFolder,
              fileSize: uploadResult.fileInfo.size,
              fileType: uploadResult.fileInfo.mimeType,
              uploadedAt: uploadResult.fileInfo.uploadedAt,
              isAppleHealth: isAppleHealth
            },
            updateInitialFile: !!currentEntry?.isInitial
          })
        });
        console.log('[SAVE-RESTORE] Rehydration metadata saved', {
          userId: props.userId,
          fileName: uploadResult.fileInfo.fileName,
          chipStatus: currentEntry?.chipStatus || 'not_in_kb',
          kbName: currentEntry?.kbName || null
        });
      } catch (metadataError) {
        console.warn('Rehydration metadata update failed:', metadataError);
      }
    }
    rehydrationCompleted.value.add(expected);
    rehydrationStep.value += 1;
    await loadFiles();
    console.log('[SAVE-RESTORE] Rehydration file restored', {
      userId: props.userId,
      fileName: expected,
      remaining: rehydrationRemaining.value.length
    });
    emit('rehydration-file-removed', {
      fileName: expected,
      bucketKey: currentEntry?.bucketKey
    });
  } catch (error) {
    console.error('Rehydration upload failed:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to upload file',
        timeout: 4000
      });
    }
  } finally {
    rehydrationUploading.value = false;
  }

  if (rehydrationRemaining.value.length === 0) {
    const hasInitialFile = rehydrationQueue.value.some(entry => !!entry.isInitial);
    console.log('[SAVE-RESTORE] Rehydration complete', {
      userId: props.userId,
      hasInitialFile
    });
    emit('rehydration-complete', { hasInitialFile });
  }
};

const hasCheckboxChanges = computed(() => {
  if (originalFiles.value.length !== userFiles.value.length) return true;
  return userFiles.value.some((file, index) => {
    const original = originalFiles.value[index];
    return !original || file.inKnowledgeBase !== original.inKnowledgeBase || !!file.pendingKbAdd;
  });
});

const hasPendingKbAdds = computed(() => userFiles.value.some(file => !!file.pendingKbAdd));

// Mark KB as dirty when files are moved
watch(hasCheckboxChanges, (hasChanges) => {
  if (hasChanges && !indexingKB.value) {
    kbNeedsUpdate.value = true;
  }
});
// Check if KB folder contents match indexed files
const kbIndexingOutOfSync = computed(() => {
  // Get all files currently in KB folder (inKnowledgeBase = true)
  const currentKBFiles = userFiles.value
    .filter(file => file.inKnowledgeBase)
    .map(file => file.bucketKey);
  
  // Sort both arrays for comparison
  const currentSorted = [...currentKBFiles].sort();
  const indexedSorted = [...indexedFiles.value].sort();
  
  // Compare arrays
  if (currentSorted.length !== indexedSorted.length) return true;
  return currentSorted.some((key, index) => key !== indexedSorted[index]);
});

// Computed property that returns a function to check if a file is indexed (ensures reactivity)
const isFileIndexed = computed(() => {
  // Create a Set for O(1) lookup
  const indexedSet = new Set(indexedFiles.value);
  // Return a function that checks if a bucketKey is in the set
  return (bucketKey: string): boolean => {
    return indexedSet.has(bucketKey);
  };
});

const indexingKB = ref(false);
const indexingStatus = ref({
  phase: 'moving', // 'moving' | 'kb_setup' | 'indexing_started' | 'indexing' | 'complete' | 'error'
  message: '',
  kb: '',
  tokens: '',
  filesIndexed: 0,
  progress: 0,
  error: ''
});

const currentIndexingJobId = ref<string | null>(null);
const pollingInterval = ref<ReturnType<typeof setInterval> | null>(null);
const elapsedTimeInterval = ref<ReturnType<typeof setInterval> | null>(null);
const indexingStartTime = ref<number | null>(null);
const INDEXING_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const elapsedTimeUpdate = ref(0); // Force updates for elapsed time display

// Computed property for elapsed time display
const indexingElapsedTime = computed(() => {
  if (!indexingStartTime.value) return null;
  // Use elapsedTimeUpdate to force reactivity
  void elapsedTimeUpdate.value; // Force reactivity by reading the value
  const elapsed = Date.now() - indexingStartTime.value;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
});

// Patient summary modal state
const showSummaryAvailableModal = ref(false);
const showSummaryViewModal = ref(false);
const isSummaryModalBeforeGeneration = ref(false); // true = before generation, false = after generation
const pendingSummaryGeneration = ref<(() => Promise<void>) | null>(null);
const newPatientSummary = ref('');
const editingSummary = ref(false);
const summaryViewText = ref('');
const isEditingSummaryTab = ref(false);
const summaryEditText = ref('');
const isSavingSummary = ref(false);

watch(patientSummary, (newValue) => {
  if (!isEditingSummaryTab.value) {
    summaryEditText.value = newValue || '';
  }
});

const hasUnsavedAgentChanges = computed(() => {
  if (!editMode.value) return false;
  const current = (editedInstructions.value || '').trim();
  const original = (agentInstructions.value || '').trim();
  return current !== original;
});

const hasUnsavedSummaryChanges = computed(() => {
  if (!isEditingSummaryTab.value) return false;
  const current = (summaryEditText.value || '').trim();
  const original = (patientSummary.value || '').trim();
  return current !== original;
});

const hasUnsavedChanges = computed(() => hasUnsavedAgentChanges.value || hasUnsavedSummaryChanges.value);

const $q = useQuasar();

const loadFiles = async () => {
  loadingFiles.value = true;
  filesError.value = '';

  try {
    // no-op

    // Then load files as normal
    const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}&source=saved`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch files: ${response.statusText}`);
    }
    const result = await response.json();
    
    const kbName = result.kbName as string | undefined;
    const kbFolderPrefix = kbName ? `${props.userId}/${kbName}/` : null;
    userFiles.value = (result.files || []).map((file: any) => {
      const bucketKey = file.bucketKey || '';
      const isInKB = typeof file.inKnowledgeBase === 'boolean'
        ? file.inKnowledgeBase
        : (kbFolderPrefix ? bucketKey.startsWith(kbFolderPrefix) : false);
      return {
        ...file,
        inKnowledgeBase: isInKB,
        pendingKbAdd: false
      };
    });
    originalFiles.value = JSON.parse(JSON.stringify(userFiles.value));

    let pendingFileName: string | null = null;
    try {
      pendingFileName = localStorage.getItem(getWizardPendingKey());
    } catch (error) {
      pendingFileName = null;
    }

    if (pendingFileName) {
      const pendingFile = userFiles.value.find(file => file.fileName === pendingFileName);
      if (pendingFile) {
        pendingFile.pendingKbAdd = true;
        if (!pendingFile.inKnowledgeBase) {
          pendingFile.inKnowledgeBase = true;
          await onCheckboxChange(pendingFile, { silent: true });
        }
      } else {
        clearWizardPendingStorage();
      }
    }
    
    const indexingActive = !!result.kbIndexingActive;
    kbDataSourceCount.value = typeof result.kbDataSourceCount === 'number' ? result.kbDataSourceCount : null;
    kbIndexedDataSourceCount.value = typeof result.kbIndexedDataSourceCount === 'number' ? result.kbIndexedDataSourceCount : null;

    indexedFiles.value = Array.isArray(result.kbIndexedBucketKeys)
      ? result.kbIndexedBucketKeys
      : [];
    kbSummaryFiles.value = indexedFiles.value.length;
    kbSummaryTokens.value = result.kbTotalTokens !== undefined && result.kbTotalTokens !== null
      ? result.kbTotalTokens
      : null;

    kbNeedsUpdate.value = false;
    if (!indexingActive && pendingFileName) {
      const pendingFile = userFiles.value.find(file => file.fileName === pendingFileName);
      if (pendingFile && isFileIndexed.value(pendingFile.bucketKey)) {
        pendingFile.pendingKbAdd = false;
        clearWizardPendingStorage();
      }
    }

  } catch (err) {
    filesError.value = err instanceof Error ? err.message : 'Failed to load files';
  } finally {
    loadingFiles.value = false;
  }
};

// const _toggleKnowledgeBase = async (file: UserFile) => {
//   updatingFiles.value.add(file.bucketKey);
//
//   try {
//     const response = await fetch('/api/toggle-file-knowledge-base', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json'
//       },
//       credentials: 'include',
//       body: JSON.stringify({
//         userId: props.userId,
//         bucketKey: file.bucketKey,
//         inKnowledgeBase: file.inKnowledgeBase
//       })
//     });
//
//     if (!response.ok) {
//       throw new Error('Failed to update knowledge base status');
//     }
//
//     // Reload files to get updated state
//     await loadFiles();
//   } catch (err) {
//     filesError.value = err instanceof Error ? err.message : 'Failed to update knowledge base status';
//     // Revert checkbox on error
//     file.inKnowledgeBase = !file.inKnowledgeBase;
//   } finally {
//     updatingFiles.value.delete(file.bucketKey);
//   }
// };

const loadAgent = async () => {
  loadingAgent.value = true;
  agentError.value = '';

  try {
    const response = await fetch(`/api/agent-instructions?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch agent: ${response.statusText}`);
    }
    const result = await response.json();
    agentInstructions.value = result.instructions || '';
    editedInstructions.value = result.instructions || '';
    kbInfo.value = result.kbInfo || null;
    
    // Load deep link Private AI access setting
    await loadDeepLinkPrivateAISetting();
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : 'Failed to load agent';
  } finally {
    loadingAgent.value = false;
  }
};

const loadDeepLinkPrivateAISetting = async () => {
  try {
    const response = await fetch(`/api/user-settings?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (response.ok) {
      const result = await response.json();

      if (result.followupJobId && result.followupJobId !== currentIndexingJobId.value) {
        currentIndexingJobId.value = result.followupJobId;
        if (pollingInterval.value) {
          clearInterval(pollingInterval.value);
          pollingInterval.value = null;
        }
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        indexingStatus.value.message = result.message || 'Indexing remaining files...';
        await pollIndexingProgress(result.followupJobId);
        return;
      }
      // Default to true if not set (backward compatibility)
      allowDeepLinkPrivateAI.value = result.allowDeepLinkPrivateAI !== undefined ? result.allowDeepLinkPrivateAI : true;
    }
  } catch (err) {
    // If endpoint doesn't exist yet or fails, default to true
    console.warn('Failed to load deep link setting, defaulting to enabled:', err);
    allowDeepLinkPrivateAI.value = true;
  }
};

const saveDeepLinkPrivateAISetting = async () => {
  savingDeepLinkSetting.value = true;
  try {
    const response = await fetch('/api/user-settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        allowDeepLinkPrivateAI: allowDeepLinkPrivateAI.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save setting');
    }

    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: allowDeepLinkPrivateAI.value 
          ? 'Deep link users can now access your Private AI' 
          : 'Deep link users can no longer access your Private AI',
        timeout: 3000
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to save setting';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: errorMsg,
        timeout: 3000
      });
    }
    // Revert on error
    allowDeepLinkPrivateAI.value = !allowDeepLinkPrivateAI.value;
  } finally {
    savingDeepLinkSetting.value = false;
  }
};

const saveInstructions = async () => {
  savingInstructions.value = true;

  try {
    const response = await fetch('/api/agent-instructions', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        instructions: editedInstructions.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save instructions');
    }

    agentInstructions.value = editedInstructions.value;
    editMode.value = false;
  } catch (err) {
    agentError.value = err instanceof Error ? err.message : 'Failed to save instructions';
  } finally {
    savingInstructions.value = false;
  }
};

const cancelEdit = () => {
  editedInstructions.value = agentInstructions.value;
  editMode.value = false;
};

// Format relative time (minutes, hours, days ago)
const formatRelativeTime = (dateString: string | null): string => {
  if (!dateString) return 'Never';
  
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
};

// Toggle KB connection
const toggleKBConnection = async () => {
  if (!kbInfo.value || togglingKB.value) return;
  
  togglingKB.value = true;
  
  // Store the current state for rollback on error
  const wasConnected = kbInfo.value.connected;
  
  try {
    const action = wasConnected ? 'detach' : 'attach';
    const response = await fetch('/api/toggle-kb-connection', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        action: action
      })
    });

    if (!response.ok) {
      throw new Error('Failed to toggle KB connection');
    }

    const result = await response.json();
    
    // Use the response directly - it's the source of truth from the backend
    // No need to call loadAgent() which goes through a cache
    if (kbInfo.value && typeof result.connected === 'boolean') {
      kbInfo.value.connected = result.connected;
    }
    
    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: result.message || `KB ${action === 'attach' ? 'attached' : 'detached'} successfully`,
        timeout: 3000
      });
    }
  } catch (err) {
    // Revert on error
    if (kbInfo.value) {
      kbInfo.value.connected = wasConnected;
    }
    const errorMsg = err instanceof Error ? err.message : 'Failed to toggle KB connection';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: errorMsg,
        timeout: 5000
      });
    }
  } finally {
    togglingKB.value = false;
  }
};

// Get file names from indexed files (extract from bucketKey) - computed property for performance
const indexedFileNames = computed((): string[] => {
  return indexedFiles.value.map(bucketKey => {
    // Extract filename from bucketKey (format: userId/kbName/filename or userId/archived/filename)
    const parts = bucketKey.split('/');
    return parts[parts.length - 1] || bucketKey;
  });
});

const loadSharedChats = async () => {
  loadingChats.value = true;
  chatsError.value = '';

  try {
    const response = await fetch(`/api/shared-group-chats?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch chats: ${response.statusText}`);
    }
    const result = await response.json();
    sharedChats.value = result.chats || [];
  } catch (err) {
    chatsError.value = err instanceof Error ? err.message : 'Failed to load chats';
  } finally {
    loadingChats.value = false;
  }
};

const getLastQueryDescription = (chat: SavedChat): string => {
  if (!chat.chatHistory || chat.chatHistory.length === 0) {
    return 'No messages';
  }

  // Find the last user message
  for (let i = chat.chatHistory.length - 1; i >= 0; i--) {
    if (chat.chatHistory[i].role === 'user' && chat.chatHistory[i].content) {
      const content = chat.chatHistory[i].content;
      // Return first 100 characters
      return content.length > 100 ? content.substring(0, 100) + '...' : content;
    }
  }

  return 'No user query found';
};

const getGroupParticipants = (chat: SavedChat): string => {
  if (!chat.isShared || !chat.currentUser) {
    return 'None';
  }

  // For now, just return the current user
  // TODO: Extract all participants from chat history
  return chat.currentUser;
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    return pageText.includes('this summary displays certain health information made available to you by your healthcare provider and may not completely');
  } catch (error) {
    return false;
  }
};

const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
};

const formatNumber = (value: string | number) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(parsed)) return String(value);
  return parsed.toLocaleString();
};

const getWizardPendingKey = () =>
  props.userId ? `wizardKbPendingFileName-${props.userId}` : 'wizardKbPendingFileName';

const wizardStage3IndexingStartedKey = () =>
  props.userId ? `wizard_stage3_indexing_started_${props.userId}` : null;

const clearWizardPendingStorage = () => {
  try {
    localStorage.removeItem(getWizardPendingKey());
  } catch (error) {
    // ignore
  }
};

const clearWizardPendingKbSelection = () => {
  clearWizardPendingStorage();
  userFiles.value.forEach(file => {
    if (file.pendingKbAdd) {
      file.pendingKbAdd = false;
    }
  });
  if (!indexingKB.value) {
    kbNeedsUpdate.value = hasCheckboxChanges.value;
  }
};

const handleKbSelectionChange = async (file: UserFile, value: boolean) => {
  if (!value && file.pendingKbAdd) {
    clearWizardPendingKbSelection();
  }
  file.inKnowledgeBase = value;
  await onCheckboxChange(file);
};

const toggleKbCheckbox = async (file: UserFile) => {
  await handleKbSelectionChange(file, !file.inKnowledgeBase);
};

// File management methods
const onCheckboxChange = async (file: UserFile, options: { silent?: boolean; retry?: boolean } = {}) => {
  // Immediately move file when checkbox is toggled
  const oldBucketKey = file.bucketKey;
  const newStatus = file.inKnowledgeBase;
  
  // Add to updating set to show spinner
  updatingFiles.value.add(oldBucketKey);

  try {
    const response = await fetch('/api/toggle-file-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        bucketKey: oldBucketKey,
        inKnowledgeBase: newStatus
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.message || 'Failed to update knowledge base status';
      if (response.status === 404 && errorData.error === 'FILE_NOT_FOUND' && options.retry !== false) {
        await loadFiles();
        const refreshed = userFiles.value.find(f => f.fileName === file.fileName);
        if (refreshed) {
          refreshed.inKnowledgeBase = newStatus;
          await onCheckboxChange(refreshed, { silent: options.silent, retry: false });
          return;
        }
      }
      throw new Error(errorMsg);
    }

    const result = await response.json();
    
    // Reload files list to verify the move completed and matches the display
    await loadFiles();
    
    // Verify the file was moved correctly by checking the new file list
    const updatedFile = userFiles.value.find(f => 
      f.bucketKey === result.newBucketKey || 
      (result.newBucketKey && f.bucketKey === oldBucketKey && f.fileName === file.fileName)
    );
    
    if (updatedFile) {
      // Show success notification
      if (!options.silent && $q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: `File ${newStatus ? 'added to' : 'removed from'} knowledge base`,
          timeout: 2000
        });
      }
    }

    if (newStatus) {
      const keysToClear = [oldBucketKey, result.newBucketKey].filter(Boolean);
      emit('files-archived', keysToClear);
    }
    
    // Mark KB as dirty since a file was moved in/out of KB
    // loadFiles() now syncs from server, so no local override needed here
    
  } catch (err) {
    console.error(`Error toggling file ${file.fileName}:`, err);
    // Revert checkbox on error
    file.inKnowledgeBase = !newStatus;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to update knowledge base status',
        timeout: 5000
      });
    }
  } finally {
    // Remove from updating set - use both old and new bucketKey in case it changed
    updatingFiles.value.delete(oldBucketKey);
    // Also try to remove any potential new bucketKey if the operation partially completed
    if (file.bucketKey && file.bucketKey !== oldBucketKey) {
      updatingFiles.value.delete(file.bucketKey);
    }
  }
};

// Helper to detect file type from stored file metadata
const detectFileTypeFromMetadata = (fileName: string, fileType?: string): 'text' | 'pdf' | 'markdown' => {
  // If fileType is already set and valid, use it
  if (fileType === 'pdf' || fileType === 'text' || fileType === 'markdown') {
    return fileType;
  }
  
  // Otherwise, detect from filename
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  if (ext === 'txt' || ext === 'text') {
    return 'text';
  }
  
  // Default to text for unknown types (safer than assuming PDF)
  return 'text';
};

const viewFileInPdfViewer = (file: UserFile) => {
  viewingFile.value = {
    bucketKey: file.bucketKey,
    name: file.fileName,
    type: detectFileTypeFromMetadata(file.fileName, file.fileType)
  };
  
  // Determine file type and open appropriate viewer
  const fileType = detectFileTypeFromMetadata(file.fileName, file.fileType);
  if (fileType === 'pdf') {
    showPdfViewer.value = true;
    showTextViewer.value = false;
  } else {
    // Default to text viewer for text, markdown, and unknown types
    showTextViewer.value = true;
    showPdfViewer.value = false;
  }
};

const confirmDeleteFile = (file: UserFile) => {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Delete File',
      message: 'This will delete the file from MAIA, remove it from the knowledge base, and re-index. Make sure you have copies of your valuable files on your computer.',
      cancel: true,
      persistent: true
    }).onOk(() => {
      deleteFile(file);
    });
  } else if (window.confirm('This will delete the file from MAIA, remove it from the knowledge base, and re-index. Make sure you have copies of your valuable files on your computer. Are you sure you want to delete this file?')) {
    deleteFile(file);
  }
};

const deleteFile = async (file: UserFile) => {
  // Add file to updating set to show loading state
  updatingFiles.value.add(file.bucketKey);
  
  try {
    const response = await fetch(`/api/delete-file`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        bucketKey: file.bucketKey
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || 'Failed to delete file');
    }

    // Reload files to refresh the list
    await loadFiles();
    
    // If file was in KB, mark KB as needing update
    if (file.inKnowledgeBase) {
      kbNeedsUpdate.value = true;
    }
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'File deleted successfully',
        timeout: 3000
      });
    }

    if (props.rehydrationActive) {
      const removedName = normalizeRehydrationName(file);
      rehydrationQueue.value = rehydrationQueue.value.filter(entry => normalizeRehydrationName(entry) !== removedName);
      rehydrationCompleted.value.delete(removedName);
      console.log('[SAVE-RESTORE] Rehydration file deleted in Saved Files', {
        userId: props.userId,
        fileName: removedName,
        remaining: rehydrationQueue.value.length
      });
      emit('rehydration-file-removed', { bucketKey: file.bucketKey, fileName: file.fileName });
      if (rehydrationQueue.value.length === 0) {
        emit('rehydration-complete', { hasInitialFile: false });
      }
    }
  } catch (err) {
    console.error('Error deleting file:', err);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to delete file',
        timeout: 5000
      });
    }
  } finally {
    updatingFiles.value.delete(file.bucketKey);
  }
};

const updateAndIndexKB = async () => {
  clearWizardPendingKbSelection();
  indexingKB.value = true;
  indexingStatus.value = {
    phase: 'moving',
    message: 'Moving files to knowledge base folder...',
    kb: '',
    tokens: '',
    filesIndexed: 0,
    progress: 0,
    error: ''
  };

  try {
    // Files are already moved by checkboxes - no need to send changes array
    // Phase 1: KB Setup (no longer moving files)
    indexingStatus.value.phase = 'kb_setup';
    indexingStatus.value.message = 'Setting up knowledge base...';

    const response = await fetch('/api/update-knowledge-base', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = { message: `HTTP ${response.status}: ${response.statusText}` };
      }
      throw new Error(errorData.message || `Failed to update knowledge base: ${response.status}`);
    }

    const result = await response.json();
    
    // Update original files
    originalFiles.value = JSON.parse(JSON.stringify(userFiles.value));
    
    // Clear dirty flag since we're now indexing
    kbNeedsUpdate.value = false;
    
    // If jobId is returned, start polling
    if (result.jobId) {
      currentIndexingJobId.value = result.jobId;
      // Update phase based on response
      indexingStatus.value.phase = result.phase || 'indexing_started';
      indexingStatus.value.message = result.phase === 'indexing_started' 
        ? 'Indexing job started... This may take several minutes'
        : 'Setting up knowledge base...';
      indexingStatus.value.kb = result.kbId || result.kb || '';
      
      // Start polling for status
      pollIndexingProgress(result.jobId);
    } else if (result.error === 'INDEXING_ALREADY_RUNNING') {
      // KB already has an indexing job running - check if we can get the job ID
      if (result.kbId) {
        // Try to get the existing job ID from user document
        // For now, show a message and suggest waiting
        indexingKB.value = false;
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = result.message || 'Indexing job already running';
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'warning',
            message: 'Indexing already in progress. Please wait for it to complete.',
            timeout: 5000
          });
        } else {
          alert('Indexing already in progress. Please wait for it to complete.');
        }
      } else {
        throw new Error(result.message || 'Indexing job already running');
      }
    } else if (result.kbId && result.success) {
      // KB was created but jobId is null - indexing should start automatically
      // Poll for the job ID to appear
      indexingKB.value = true;
      indexingStatus.value.phase = 'indexing_started';
      indexingStatus.value.message = 'Knowledge base created. Waiting for indexing to start...';
      indexingStatus.value.kb = result.kbId;
      
      // Poll for job ID (up to 10 attempts with 3 second delays = 30 seconds max)
      let foundJobId = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        try {
          const statusResponse = await fetch(`/api/user-files?userId=${props.userId}`, {
            method: 'GET',
            credentials: 'include'
          });
          
          if (statusResponse.ok) {
            const statusData = await statusResponse.json();
            const jobId = statusData.kbIndexingJobId || statusData.kbLatestJobId || null;
            if (jobId) {
              foundJobId = jobId;
              break;
            }
          }
        } catch (pollError) {}
      }
      
      if (foundJobId) {
        // Found job ID - start polling for progress
        currentIndexingJobId.value = foundJobId;
        pollIndexingProgress(foundJobId);
      } else {
        // Still no job ID after polling - show message but don't error
        indexingKB.value = false;
        indexingStatus.value.phase = 'complete';
        indexingStatus.value.message = 'Knowledge base created. Indexing will start automatically - please check back in a moment.';
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'info',
            message: 'Knowledge base created. Indexing will start automatically - please check back in a moment.',
            timeout: 5000
          });
        }
        // Reload files to show updated state
        await loadFiles();
        await loadAgent();
      }
    } else {
      // No job ID and no KB ID - something went wrong
      indexingKB.value = false;
      throw new Error('No indexing job ID returned from server');
    }
  } catch (err) {
    indexingKB.value = false;
    indexingStatus.value.phase = 'error';
    indexingStatus.value.error = err instanceof Error ? err.message : 'Failed to update knowledge base';
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
        message: indexingStatus.value.error,
        timeout: 5000
    });
    } else {
      // Fallback if Quasar notify is not available
      console.error('Notification error:', indexingStatus.value.error);
      alert(`Error: ${indexingStatus.value.error}`);
    }
  }
};

const cancelIndexingAndRestore = async () => {
  if (!currentIndexingJobId.value) {
    return;
  }

  const jobId = currentIndexingJobId.value;

  try {
    // Stop polling
    if (pollingInterval.value) {
      clearInterval(pollingInterval.value);
      pollingInterval.value = null;
    }

    // Call cancel endpoint
    const response = await fetch('/api/cancel-kb-indexing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        jobId: jobId
      })
    });

    const result = await response.json();

    // Check if indexing already completed
    if (result.alreadyCompleted || result.error === 'ALREADY_COMPLETED') {
      // Indexing already completed - just clear frontend state
      
      // Reset indexing state
      indexingKB.value = false;
      currentIndexingJobId.value = null;
      if (elapsedTimeInterval.value) {
        clearInterval(elapsedTimeInterval.value);
        elapsedTimeInterval.value = null;
      }
      indexingStartTime.value = null;
      elapsedTimeUpdate.value = 0;
      indexingStatus.value = {
        phase: 'complete',
        message: 'Indexing already completed',
        kb: '',
        tokens: '',
        filesIndexed: 0,
        progress: 1.0,
        error: ''
      };
      
      // Reload files to get current state
      await loadFiles();
      
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'info',
          message: 'Indexing has already completed',
          timeout: 3000
        });
      }
      return;
    }

    if (!response.ok) {
      throw new Error(result.message || 'Failed to cancel indexing');
    }

    // Reset indexing state
    indexingKB.value = false;
    currentIndexingJobId.value = null;
    if (elapsedTimeInterval.value) {
      clearInterval(elapsedTimeInterval.value);
      elapsedTimeInterval.value = null;
    }
    indexingStartTime.value = null;
    elapsedTimeUpdate.value = 0;
    indexingStatus.value = {
      phase: 'moving',
      message: '',
      kb: '',
      tokens: '',
      filesIndexed: 0,
      progress: 0,
      error: ''
    };

    // Reload files to get restored state (this updates bucketKeys)
    await loadFiles();
    
    // Force a small delay to ensure file list is fully updated before any PDF access
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Emit event to refresh any open PDF viewers with updated bucketKeys
    emit('files-archived', []); // Empty array signals a refresh without specific files

    // Show notification
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Indexing cancelled and files restored to original state',
        timeout: 3000
      });
    }
  } catch (err) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: err instanceof Error ? err.message : 'Failed to cancel indexing',
        timeout: 5000
      });
    }
  }
};

const pollIndexingProgress = async (jobId: string) => {
  // Clear any existing polling interval
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value);
  }
  
  // Use persisted start time if indexing was started from wizard (survives reload / opening Saved Files mid-indexing)
  const storageKey = wizardStage3IndexingStartedKey();
  try {
    const stored = storageKey ? sessionStorage.getItem(storageKey) : null;
    if (stored) {
      const startedAt = parseInt(stored, 10);
      const maxAgeMs = 24 * 60 * 60 * 1000;
      if (!Number.isNaN(startedAt) && Date.now() - startedAt < maxAgeMs) {
        indexingStartTime.value = startedAt;
      } else {
        if (storageKey) sessionStorage.removeItem(storageKey);
        indexingStartTime.value = Date.now();
      }
    } else {
      indexingStartTime.value = Date.now();
    }
  } catch {
    indexingStartTime.value = Date.now();
  }
  elapsedTimeUpdate.value = 0;
  
  // Start interval to update elapsed time display every second
  if (elapsedTimeInterval.value) {
    clearInterval(elapsedTimeInterval.value);
  }
  elapsedTimeInterval.value = setInterval(() => {
    if (indexingStartTime.value) {
      elapsedTimeUpdate.value = Date.now();
    } else {
      if (elapsedTimeInterval.value) {
        clearInterval(elapsedTimeInterval.value);
        elapsedTimeInterval.value = null;
      }
    }
  }, 1000);
  
  // Emit event to parent to update status tip
  emit('indexing-started', { jobId, phase: 'indexing_started' });
  
  // Poll every 10 seconds for indexing status
  const POLL_INTERVAL_MS = 10000; // 10 seconds
  pollingInterval.value = setInterval(async () => {
    if (!isOpen.value) {
      if (pollingInterval.value) clearInterval(pollingInterval.value);
      pollingInterval.value = null;
      if (elapsedTimeInterval.value) clearInterval(elapsedTimeInterval.value);
      elapsedTimeInterval.value = null;
      return;
    }
    try {
      // Check for timeout
      const elapsed = indexingStartTime.value ? (Date.now() - indexingStartTime.value) : 0;
      if (indexingStartTime.value && elapsed > INDEXING_TIMEOUT_MS) {
        clearInterval(pollingInterval.value!);
        pollingInterval.value = null;
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        indexingStartTime.value = null;
        elapsedTimeUpdate.value = 0;
        indexingKB.value = false;
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = 'Indexing timed out after 60 minutes';
        emit('indexing-finished', { jobId, phase: 'error', error: 'Indexing timed out' });
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: 'Indexing timed out after 60 minutes. Please check the knowledge base status.'
          });
        }
        return;
      }
      
      const response = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}&source=saved`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(`Failed to get indexing status: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      if (!isOpen.value) return;
      const statusResult = result.kbIndexingStatus || {};
      if (statusResult.jobId && statusResult.jobId !== jobId) {
        return;
      }
      
      // Status check for job (verbose logging removed)
      
      // Update status with all fields from response
      indexingStatus.value = {
        phase: statusResult.phase || indexingStatus.value.phase,
        message: indexingStatus.value.message,
        kb: result.kbName || indexingStatus.value.kb,
        tokens: statusResult.tokens || indexingStatus.value.tokens || '0',
        filesIndexed: statusResult.filesIndexed || 0,
        progress: statusResult.progress || 0,
        error: statusResult.error || ''
      };
      
      // Emit status update to parent for status tip
      emit('indexing-status-update', {
        jobId,
        phase: indexingStatus.value.phase,
        tokens: indexingStatus.value.tokens,
        filesIndexed: indexingStatus.value.filesIndexed,
        progress: indexingStatus.value.progress
      });

      // Handle completion - check result.backendCompleted (backend has finished all automation),
      // result.completed, result.phase, or result.status
      // backendCompleted is the most reliable indicator that everything is done
      // Log completion detection for debugging
      const isCompleted = statusResult.backendCompleted === true;
      
      if (isCompleted) {
        if (pollingInterval.value !== null) {
          clearInterval(pollingInterval.value);
        }
        pollingInterval.value = null;
        // Note: Keep indexingStartTime and elapsedTimeUpdate for final display
        
        // Refresh dialog for any completion status (not just backendCompleted or phase='complete')
        // This ensures the UI updates when status='INDEX_JOB_STATUS_COMPLETED' even if phase is still 'indexing'
        indexingStatus.value.phase = 'complete';
        indexingStatus.value.message = 'Knowledge base indexed successfully!';
        
        if (statusResult.tokens !== undefined) {
          kbSummaryTokens.value = statusResult.tokens;
        }
        if (statusResult.filesIndexed !== undefined) {
          kbSummaryFiles.value = statusResult.filesIndexed;
        }
        
        // Reload files to refresh the file list
        await loadFiles();
        
        emit('indexing-finished', { jobId, phase: 'complete' });
        
        // Reload agent info to update KB info (including indexed files and connection status)
        if (currentTab.value === 'agent') {
          await loadAgent();
        }
        
        // Attach KB to agent (patient summary generation is disabled)
        await attachKBToAgentOnlyDuringIndexing();
        
        // Clear dirty flag since indexing completed successfully
        kbNeedsUpdate.value = false;
        
        // Clean up elapsed time interval
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
          indexingKB.value = false;
        }, 5000);
      } else if (statusResult.phase === 'error') {
        indexingStatus.value.phase = 'error';
        indexingStatus.value.error = statusResult.error || 'Indexing failed';
        emit('indexing-finished', { jobId, phase: 'error', error: indexingStatus.value.error });
        
        // Clean up elapsed time interval
        if (elapsedTimeInterval.value) {
          clearInterval(elapsedTimeInterval.value);
          elapsedTimeInterval.value = null;
        }
        
        $q.notify({
          type: 'negative',
          message: `Indexing failed: ${indexingStatus.value.error}`
        });
      }
    } catch (err) {
      clearInterval(pollingInterval.value!);
      pollingInterval.value = null;
      if (elapsedTimeInterval.value) {
        clearInterval(elapsedTimeInterval.value);
        elapsedTimeInterval.value = null;
      }
      indexingKB.value = false;
      indexingStatus.value.phase = 'error';
      indexingStatus.value.error = err instanceof Error ? err.message : 'Failed to get indexing status';
      emit('indexing-finished', { jobId, phase: 'error', error: indexingStatus.value.error });
      console.error('Error polling indexing status:', err);
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: `Error checking indexing status: ${indexingStatus.value.error}`
        });
      }
    }
  }, POLL_INTERVAL_MS);
};

// Chat management methods
const selectChat = async (chat: SavedChat) => {
  try {
    let response;
    
    // If chat has a shareId, load it via shareId endpoint (for deep links)
    if (chat.shareId) {
      response = await fetch(`/api/load-chat-by-share/${chat.shareId}`, {
      credentials: 'include'
    });
    } else {
      // Otherwise, load chat via chatId
      response = await fetch(`/api/load-chat/${chat._id}`, {
        credentials: 'include'
      });
    }
    
    if (!response.ok) {
      throw new Error(`Failed to load chat: ${response.statusText}`);
    }
    
    const result = await response.json();
    const closed = await closeDialog();
    if (closed) {
    emit('chat-selected', result.chat);
    }
  } catch (err) {
    console.error('Failed to load full chat data:', err);
    // Fallback: emit the chat we have
    const closed = await closeDialog();
    if (closed) {
    emit('chat-selected', chat);
    }
  }
};

const copyChatLink = (chat: SavedChat) => {
  if (!chat.shareId) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'Create a deep link by saving this chat first.',
        position: 'top',
        timeout: 2000
      });
    }
    return;
  }

  const baseUrl = window.location.origin;
  const link = `${baseUrl}/chat/${chat.shareId}`;

  navigator.clipboard.writeText(link)
    .then(() => {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'positive',
          message: 'Deep link copied to clipboard',
          position: 'top',
          timeout: 3000,
          color: 'primary',
          textColor: 'white'
        });
      } else {
        alert('Deep link copied to clipboard');
      }
    })
    .catch(() => {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: 'Failed to copy link',
          position: 'top',
          timeout: 3000
        });
      } else {
        alert('Failed to copy link');
      }
    });
};

const confirmDeleteChat = (chat: SavedChat) => {
  if ($q && typeof $q.dialog === 'function') {
  $q.dialog({
    title: 'Delete Chat',
    message: 'Are you sure you want to delete this chat?',
    cancel: true,
    persistent: true
  }).onOk(() => {
    deleteChat(chat);
  });
  } else if (window.confirm('Are you sure you want to delete this chat?')) {
    deleteChat(chat);
  }
};

const deleteChat = async (chat: SavedChat) => {
  try {
    await deleteChatById(chat._id);

    // Remove from list
    sharedChats.value = sharedChats.value.filter(c => c._id !== chat._id);
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Chat deleted successfully'
    });
    }
  } catch (err) {
    if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'negative',
      message: err instanceof Error ? err.message : 'Failed to delete chat'
    });
    } else {
      console.error('Failed to delete chat:', err);
    }
  }
};

// Helper function to attach KB to agent
const attachKBToAgentOnly = async () => {
  const attachResponse = await fetch('/api/attach-kb-to-agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({
      userId: props.userId
    })
  });

  if (!attachResponse.ok) {
    const errorData = await attachResponse.json();
    throw new Error(errorData.message || 'Failed to attach KB to agent');
  }

  await attachResponse.json();
};

// Attach KB to agent (patient summary generation is disabled)
const attachKBToAgentOnlyDuringIndexing = async () => {
  try {
    // Keep indexing status visible and update message
    indexingStatus.value.message = 'Attaching knowledge base to agent...';
    emit('indexing-status-update', {
      jobId: currentIndexingJobId.value || '',
      phase: 'kb_setup',
      tokens: indexingStatus.value.tokens,
      filesIndexed: indexingStatus.value.filesIndexed,
      progress: 1.0
    });
    
    await attachKBToAgentOnly();
  } catch (error) {
    indexingStatus.value.message = `Error: ${error instanceof Error ? error.message : 'Failed to attach KB'}`;
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to attach KB'
      });
    }
  }
};

// Handle confirmation to replace summary (before generation)
const handleConfirmReplaceSummary = async () => {
  showSummaryAvailableModal.value = false;
  isSummaryModalBeforeGeneration.value = false;
  if (pendingSummaryGeneration.value) {
    try {
      await pendingSummaryGeneration.value();
    } catch (error) {
      if ($q && typeof $q.notify === 'function') {
        $q.notify({
          type: 'negative',
          message: error instanceof Error ? error.message : 'Failed to generate patient summary'
        });
      }
    } finally {
      pendingSummaryGeneration.value = null;
    }
  }
};

// Handle replace summary by index (when all slots are full)
const handleReplaceSummaryByIndex = async (indexToReplace: number) => {
  showReplaceSummaryDialog.value = false;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: newSummaryToReplace.value,
        replaceIndex: indexToReplace
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    await response.json(); // Response processed, but result not needed
    
    // Reload summaries to get updated list
    await loadPatientSummary();
    summaryNeedsVerify.value = true;
    emit('patient-summary-saved', { userId: props.userId });
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!',
        timeout: 3000
      });
    }
    
    newSummaryToReplace.value = '';
  } catch (error) {
    console.error('Error saving summary:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary',
        timeout: 5000
      });
    }
  }
};

// Handle replace summary dialog choice (for empty slots or keep strategy)
const handleReplaceSummary = async (replaceStrategy: 'keep' | 'oldest' | 'newest', summaryText?: string) => {
  showReplaceSummaryDialog.value = false;
  
  const summaryToSave = summaryText || newSummaryToReplace.value;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave,
        replaceStrategy: replaceStrategy
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    await response.json(); // Response processed, but result not needed
    
    // Reload summaries to get updated list
    await loadPatientSummary();
    summaryNeedsVerify.value = true;
    emit('patient-summary-saved', { userId: props.userId });
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: replaceStrategy === 'keep' ? 'Current summary kept' : 'Patient summary saved successfully!',
        timeout: 3000
      });
    }
    
    newSummaryToReplace.value = '';
  } catch (error) {
    console.error('Error saving summary:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary',
        timeout: 5000
      });
    }
  }
};

// Handle closing the summary modal
const handleCloseSummaryModal = () => {
  showSummaryAvailableModal.value = false;
  if (isSummaryModalBeforeGeneration.value) {
    // If it was before generation, cancel the pending generation
    pendingSummaryGeneration.value = null;
    isSummaryModalBeforeGeneration.value = false;
  } else {
    // If it was after generation, close the dialog
    handleCloseMyStuff();
  }
};

// Patient Summary modal handlers
const handleSaveSummary = async () => {
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: newPatientSummary.value
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save patient summary');
    }

    // Update local summary
    patientSummary.value = newPatientSummary.value;
    summaryEditText.value = newPatientSummary.value;
    isEditingSummaryTab.value = false;
    summaryNeedsVerify.value = true;

    emit('patient-summary-saved', { userId: props.userId });
    
    showSummaryAvailableModal.value = false;
    if (showSummaryViewModal.value) {
      showSummaryViewModal.value = false;
    }
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary'
      });
    }
  }
};

const handleCloseMyStuff = () => {
  showSummaryAvailableModal.value = false;
  emit('update:modelValue', false);
};

const handleEditSummary = () => {
  editingSummary.value = true;
};

const handleSaveEditedSummary = async () => {
  const summaryToSave = editingSummary.value ? summaryViewText.value : newPatientSummary.value;
  
  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave
      })
    });

    if (!response.ok) {
      throw new Error('Failed to save patient summary');
    }

    // Update local values
    newPatientSummary.value = summaryToSave;
    patientSummary.value = summaryToSave;
    summaryEditText.value = summaryToSave;
    isEditingSummaryTab.value = false;
    editingSummary.value = false;
    showSummaryViewModal.value = false;
    
    emit('patient-summary-saved', { userId: props.userId });
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save patient summary'
      });
    }
  }
};

const handleCloseWithoutSaving = () => {
  if (editingSummary.value) {
    // Revert changes
    summaryViewText.value = newPatientSummary.value;
    editingSummary.value = false;
  } else {
    showSummaryViewModal.value = false;
  }
};

// Patient Summary methods
// Helper function to format time ago
const getTimeAgo = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffDays > 0) {
    return `${diffDays} ${diffDays === 1 ? 'day' : 'days'}`;
  } else if (diffHours > 0) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'}`;
  } else {
    return `${diffMins} ${diffMins === 1 ? 'minute' : 'minutes'}`;
  }
};

// Swap summary function
const swapSummary = async (index: number) => {
  try {
    const response = await fetch('/api/patient-summary/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        index: index
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to swap summary');
    }

    await response.json(); // Response processed, but result not needed
    // Reload summaries
    await loadPatientSummary();
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Summary swapped successfully',
        timeout: 3000
      });
    }
  } catch (error) {
    console.error('Error swapping summary:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to swap summary',
        timeout: 5000
      });
    }
  }
};

// Strip leading titles (Dr, Dr., Mr, Mrs, Ms, Prof., RN, CNP, OD) for canonical name comparison
const stripNameTitles = (name: string): string => {
  const t = name
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutTitle = t.replace(
    /^(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i,
    ''
  ).trim();
  return withoutTitle || t;
};

// Map last name (lowercase) -> full name from a list of names we already have (mapping originals or extracted).
// Used to resolve "Gropper" -> "Adrian Gropper" when we have "Adrian Gropper" in the mapping. First occurrence wins.
const buildLastNameToFullNameFromFullNames = (originals: string[]): Map<string, string> => {
  const m = new Map<string, string>();
  for (const orig of originals) {
    const full = stripNameTitles(orig);
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1].toLowerCase();
      if (!m.has(last)) {
        m.set(last, full);
      }
    }
  }
  return m;
};

// Canonical form for one person: "First Last". Resolves "Last" / "Dr Last" to "First Last" when we have that full name in our map (from mapping or extracted names).
const toCanonical = (
  name: string,
  lastNameToFullName?: Map<string, string>
): string => {
  const stripped = stripNameTitles(name);
  const parts = stripped.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return parts.join(' ');
  }
  if (parts.length === 1 && lastNameToFullName) {
    const full = lastNameToFullName.get(parts[0].toLowerCase());
    if (full) return full;
  }
  return stripped;
};

// Helper function to deduplicate mapping (used both on load and when adding new names).
// If getCanonical is provided, two originals are treated as the same person when they share the same canonical name
// (e.g. "First Last", "Dr First Last", "Dr. Last" -> one entry with original "First Last").
const deduplicateMapping = (
  mappings: Array<{ original: string; pseudonym: string }>,
  getCanonical?: (original: string) => string
): {
  deduplicated: Array<{ original: string; pseudonym: string }>;
  removed: string[];
} => {
  const seen = new Set<string>();
  const deduplicatedMapping: Array<{ original: string; pseudonym: string }> = [];
  const duplicatesRemoved: string[] = [];

  // When using canonical form, process full names first so we keep "Adrian Gropper" over "Gropper" as the display original
  const toProcess = getCanonical
    ? [...mappings].sort((a, b) => {
        const wordsA = getCanonical(a.original).split(/\s+/).filter(Boolean).length;
        const wordsB = getCanonical(b.original).split(/\s+/).filter(Boolean).length;
        return wordsB - wordsA;
      })
    : mappings;

  for (const mapping of toProcess) {
    const key = getCanonical
      ? getCanonical(mapping.original).replace(/\s+/g, ' ').trim().toLowerCase()
      : mapping.original
          .replace(/\u00A0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      const displayOriginal = getCanonical ? getCanonical(mapping.original) : mapping.original;
      deduplicatedMapping.push({
        original: displayOriginal,
        pseudonym: mapping.pseudonym
      });
    } else {
      duplicatesRemoved.push(mapping.original);
    }
  }

  return { deduplicated: deduplicatedMapping, removed: duplicatesRemoved };
};

// Remove single-word mappings that are the first name of a full-name mapping (e.g. keep "Roger Pasinski", remove "Roger").
const dropOrphanFirstNames = (
  mappings: Array<{ original: string; pseudonym: string }>
): Array<{ original: string; pseudonym: string }> => {
  const firstNamesOfFullNames = new Set(
    mappings
      .filter((m) => m.original.split(/\s+/).length >= 2)
      .map((m) => m.original.split(/\s+/)[0].toLowerCase())
  );
  return mappings.filter((m) => {
    const parts = m.original.split(/\s+/);
    if (parts.length === 1 && firstNamesOfFullNames.has(parts[0].toLowerCase())) {
      return false;
    }
    return true;
  });
};

const loadPrivacyFilter = async () => {
  loadingPrivacyFilter.value = true;
  privacyFilterError.value = '';
  privacyFilterResponse.value = '';

  try {
    // Build last-name -> full-name from the mapping we load (so "Gropper" merges with "Adrian Gropper")
    const getCanonicalFromMapping = (mapping: Array<{ original: string; pseudonym: string }>) => {
      const lastNameToFullName = buildLastNameToFullNameFromFullNames(mapping.map(m => m.original));
      return (orig: string) => toCanonical(orig, lastNameToFullName);
    };

    // Always try to load existing mapping first (cumulative - never deleted)
    try {
      const loadResponse = await fetch('/api/privacy-filter-mapping', {
        credentials: 'include'
      });

      if (!loadResponse.ok) {
        privacyFilterMapping.value = [];
      } else {
        const loadData = await loadResponse.json();
        if (loadData.mapping && loadData.mapping.length > 0) {
          const { deduplicated, removed } = deduplicateMapping(loadData.mapping, getCanonicalFromMapping(loadData.mapping));
          const cleaned = dropOrphanFirstNames(deduplicated);

          if (removed.length > 0 || cleaned.length !== deduplicated.length) {
            try {
              await fetch('/api/privacy-filter-mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ mapping: cleaned })
              });
            } catch (saveErr) {
              // Silently handle save errors
            }
          }

          privacyFilterMapping.value = cleaned;
        } else {
          const mapping = loadData.mapping || [];
          const { deduplicated } = deduplicateMapping(mapping, getCanonicalFromMapping(mapping));
          privacyFilterMapping.value = dropOrphanFirstNames(deduplicated);
        }
      }
    } catch (loadErr) {
      privacyFilterMapping.value = [];
    }

    // Always run deduplication on the current mapping value (in case it was set elsewhere)
    if (privacyFilterMapping.value.length > 0) {
      const current = privacyFilterMapping.value;
      const { deduplicated, removed } = deduplicateMapping(current, getCanonicalFromMapping(current));
      const cleaned = dropOrphanFirstNames(deduplicated);
      if (removed.length > 0 || cleaned.length !== privacyFilterMapping.value.length) {
        privacyFilterMapping.value = cleaned;
        try {
          await fetch('/api/privacy-filter-mapping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ mapping: cleaned })
          });
        } catch (saveErr) {
          // Silently handle save errors
        }
      }
    }

    // Use originalMessages if available (unfiltered), otherwise fall back to props.messages
    const allMessages = (props.originalMessages && props.originalMessages.length > 0) 
      ? props.originalMessages 
      : props.messages;
    
    // Filter to only Private AI messages and user messages for name extraction
    // Private AI is identified by providerKey === 'digitalocean'
    const messagesToAnalyze = allMessages.filter(msg => {
      // Include user messages (they may contain names)
      if (msg.role === 'user') {
        return true;
      }
      // Include only Private AI assistant messages
      if (msg.role === 'assistant') {
        const isPrivateAI = (msg as any).providerKey === 'digitalocean' || 
                            (msg as any).authorLabel === 'Private AI' ||
                            (msg as any).name === 'Private AI';
        return isPrivateAI;
      }
      return false;
    });
    
    // Check if we have messages to query Private AI
    if (!messagesToAnalyze || messagesToAnalyze.length === 0) {
      // Still show existing mapping if available - don't set error if mapping exists
      if (privacyFilterMapping.value.length === 0) {
        privacyFilterError.value = 'No Private AI chat messages available';
      }
      return;
    }

    // Prepare messages for Private AI query
    // Include only Private AI chat messages plus the privacy filter question
    // IMPORTANT: We only want names from the chat messages themselves, not from knowledge base documents
    const chatMessagesOnly = messagesToAnalyze.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    
    const queryMessages = [
      ...chatMessagesOnly,
      {
        role: 'user' as const,
        content: 'Based ONLY on the chat messages above (ignore any information from your knowledge base or retrieved documents), what names of people are explicitly mentioned in this chat conversation? List only names that appear in the chat messages themselves.'
      }
    ];

    // Query Private AI
    const response = await fetch('/api/chat/digitalocean', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      credentials: 'include',
      body: JSON.stringify({
        messages: queryMessages,
        options: {
          stream: true
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || 'Failed to query Private AI');
    }

    // Read streaming response
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let responseText = '';

    if (!reader) {
      throw new Error('Failed to read response stream');
    }

    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      
      // Process complete lines (ending with \n\n)
      const lines = buffer.split('\n\n');
      // Keep the last incomplete line in buffer
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            
            // Only use delta for incremental content (like ChatInterface does)
            // Ignore content field to avoid duplication
            if (data.delta) {
              responseText += data.delta;
            }
            
            // Check if response is complete
            if (data.isComplete) {
              break;
            }
          } catch (e) {
            // Skip malformed JSON - might be partial chunk
          }
        }
      }
    }
    
    // Store the raw response
    privacyFilterResponse.value = responseText.trim();
    
    // Always check for new names and add them to existing mapping (cumulative)
    await createPseudonymMapping(responseText.trim());
  } catch (err) {
    privacyFilterError.value = err instanceof Error ? err.message : 'Failed to analyze chat for names';
  } finally {
    loadingPrivacyFilter.value = false;
  }
};

const createPseudonymMapping = async (responseText: string) => {
  loadingRandomNames.value = true;
  
  try {
    // Load random names from backend API (empty list if endpoint missing or fails)
    let randomNamesList: string[] = [];
    try {
      const randomNamesResponse = await fetch('/api/random-names');
      if (randomNamesResponse.ok) {
        const randomNamesData = await randomNamesResponse.json();
        randomNamesList = randomNamesData.names || [];
      }
    } catch (_) {
      randomNamesList = [];
    }
    
    // Parse names from Privacy Filter response (robust to formatting: bullets, tables, headers)
    // 1) Normalize: strip markdown list/header prefixes, then collect line content and table cells
    const rawLines = responseText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const nameCandidates: string[] = [];
    for (const line of rawLines) {
      const stripped = line
        .replace(/^\s*#+\s*/, '')           // ## Header
        .replace(/^\s*[-*]\s*/, '')        // - or * bullet
        .replace(/^\s*\d+[.)]\s*/, '')     // 1. or 1) numbered list
        .trim();
      if (!stripped) continue;
      if (stripped.includes('|')) {
        const cells = stripped.split('|').map(c => c.trim()).filter(Boolean);
        nameCandidates.push(...cells);
      } else {
        nameCandidates.push(stripped);
      }
    }

    const namePatterns = [
      /^(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/,
      /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/,
      /^(?:Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?)\s+([A-Z][a-z]+)/,
      /^([A-Z][a-z]+)$/
    ];

    const skipWords = new Set(['name', 'role', 'patient', 'column']);
    const titleWords = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'rn', 'cnp', 'od']);
    const extractedNames: string[] = [];
    const initialLastNamePattern = /\b([A-Z])\.\s+([A-Z][a-z]+)(?:\s|$|,)/g; // "C. Pasinski" or "X. LastName,"
    for (const candidate of nameCandidates) {
      const cleanLine = candidate.replace(/\s*\([^)]*\)/g, '').trim();
      if (!cleanLine) continue;
      for (const pattern of namePatterns) {
        const match = cleanLine.match(pattern);
        if (match) {
          const name = match[1] || match[0];
          if (name && name.length > 1 && !skipWords.has(name.toLowerCase())) {
            extractedNames.push(name);
            if (pattern === namePatterns[0] && match[0] !== name) {
              extractedNames.push(match[0]);
            }
            break;
          }
        }
      }
      // Also extract last names after middle initial; if a first name precedes "X. LastName", use full name to avoid separate mappings
      let initialMatch;
      initialLastNamePattern.lastIndex = 0;
      while ((initialMatch = initialLastNamePattern.exec(cleanLine)) !== null) {
        const lastName = initialMatch[2];
        if (!lastName || lastName.length <= 1 || skipWords.has(lastName.toLowerCase())) continue;
        const beforeInitial = cleanLine.substring(0, initialMatch.index).trim();
        const wordsBefore = beforeInitial.split(/\s+/).filter(Boolean);
        const lastWord = wordsBefore.length > 0 ? wordsBefore[wordsBefore.length - 1] : '';
        const looksLikeFirstName = lastWord && /^[A-Z][a-z]+$/.test(lastWord) && !titleWords.has(lastWord.toLowerCase()) && !skipWords.has(lastWord.toLowerCase());
        if (looksLikeFirstName) {
          extractedNames.push(`${lastWord} ${lastName}`);
        } else {
          extractedNames.push(lastName);
        }
      }
    }
    
    // Remove duplicates from extracted names (case-insensitive)
    const seenExtracted = new Set<string>();
    const uniqueExtractedNames: string[] = [];
    for (const name of extractedNames) {
      const key = name.toLowerCase();
      if (!seenExtracted.has(key)) {
        seenExtracted.add(key);
        uniqueExtractedNames.push(name);
      }
    }
    
    // Resolve "Last" -> "First Last" using names we already have (mapping + extracted), not Random Names
    const lastNameToFullName = buildLastNameToFullNameFromFullNames([
      ...(privacyFilterMapping.value || []).map(m => m.original),
      ...uniqueExtractedNames
    ]);
    const getCanonicalForMerge = (orig: string) => toCanonical(orig, lastNameToFullName);

    // Start with existing mapping (cumulative - never delete)
    const existingMapping = privacyFilterMapping.value || [];
    const existingCanonicals = new Set(
      existingMapping.map(m => getCanonicalForMerge(m.original).toLowerCase())
    );

    // One mapping per person: convert each extracted name to canonical "First Last" (or "Last" -> resolved to "First Last" via Random Names)
    const newNames: string[] = [];
    for (const name of uniqueExtractedNames) {
      const canonical = toCanonical(name, lastNameToFullName);
      const key = canonical.toLowerCase();
      if (!existingCanonicals.has(key) && !newNames.some(n => n.toLowerCase() === key)) {
        newNames.push(canonical);
      }
    }
    if (newNames.length === 0) {
      return; // No new names, keep existing mapping
    }
    
    // Create pseudonym mapping for new names only
    const newMappings: Array<{ original: string; pseudonym: string }> = [];
    const usedRandomNames = new Set<number>();
    
    // Track which random names are already used in existing mapping
    existingMapping.forEach((m: { original: string; pseudonym: string }) => {
      // Extract the random name from pseudonym (e.g., "Emily45 Johnson67" -> "Emily Johnson")
      const pseudonymParts = m.pseudonym.split(/\s+/);
      if (pseudonymParts.length >= 2) {
        const firstName = pseudonymParts[0].replace(/\d+$/, ''); // Remove trailing numbers
        const lastName = pseudonymParts[1].replace(/\d+$/, ''); // Remove trailing numbers
        const randomName = `${firstName} ${lastName}`;
        const index = randomNamesList.findIndex((name: string) => name === randomName);
        if (index >= 0) {
          usedRandomNames.add(index);
        }
      }
    });
    
    for (const originalName of newNames) {
      // Pick a random name from the list (without replacement to avoid duplicates)
      let randomIndex: number;
      let attempts = 0;
      do {
        randomIndex = Math.floor(Math.random() * randomNamesList.length);
        attempts++;
        // If we've used all names, reset (allow reuse)
        if (attempts > randomNamesList.length * 2) {
          usedRandomNames.clear();
          break;
        }
      } while (usedRandomNames.has(randomIndex));
      
      usedRandomNames.add(randomIndex);
      const randomName = randomNamesList[randomIndex];
      
      // Split into first and last name
      const nameParts = randomName.split(/\s+/);
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || nameParts[1] || '';
      
      // Generate random numbers (10-99) for first and last name
      const firstNum = Math.floor(Math.random() * 90) + 10; // 10-99
      const lastNum = Math.floor(Math.random() * 90) + 10; // 10-99
      
      // Create pseudonym: "FirstNameXX LastNameYY"
      const pseudonym = lastName 
        ? `${firstName}${firstNum} ${lastName}${lastNum}`
        : `${firstName}${firstNum}`;
      
      // Validate pseudonym before adding
      if (!pseudonym || pseudonym.trim() === '') {
        continue; // Skip this name
      }
      
      newMappings.push({ original: originalName, pseudonym });
    }
    
    // Merge new mappings with existing ones; deduplicate by canonical name so "Dr First Last" and "First Last" become one entry
    const allMappings = [...existingMapping, ...newMappings];
    const { deduplicated: deduplicatedMapping, removed: duplicateRemoved } = deduplicateMapping(
      allMappings,
      getCanonicalForMerge
    );

    const mappingWithoutOrphanFirstNames = dropOrphanFirstNames(deduplicatedMapping);
    
    privacyFilterMapping.value = mappingWithoutOrphanFirstNames;
    
    // Always save the deduplicated mapping to ensure storage is clean
    if (duplicateRemoved.length > 0 || newMappings.length > 0 || mappingWithoutOrphanFirstNames.length !== deduplicatedMapping.length) {
      try {
        await fetch('/api/privacy-filter-mapping', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({ mapping: mappingWithoutOrphanFirstNames })
        });
        // Silently handle save errors
      } catch (saveErr) {
        // Silently handle save errors
      }
    }
    
    // Save updated mapping to user document
    try {
      await fetch('/api/privacy-filter-mapping', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({ mapping: mappingWithoutOrphanFirstNames })
      });
      
        // Silently handle save errors
      } catch (saveErr) {
        // Don't fail the whole operation if save fails
      }
  } catch (err) {
    privacyFilterMapping.value = [];
  } finally {
    loadingRandomNames.value = false;
  }
};

const filterCurrentChat = () => {
  // Prefer originalMessages (truly original unfiltered) if available, otherwise use props.messages
  // The condition checks if originalMessages exists and has content
  // IMPORTANT: props.originalMessages is trulyOriginalMessages from ChatInterface, which is never filtered
  const messagesToFilter = (props.originalMessages && props.originalMessages.length > 0) 
    ? props.originalMessages 
    : (props.messages && props.messages.length > 0 ? props.messages : []);
  
  if (!messagesToFilter || messagesToFilter.length === 0) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'No chat messages available to filter',
        timeout: 3000
      });
    }
    return;
  }
  
  if (privacyFilterMapping.value.length === 0) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'No pseudonym mapping available. Please analyze the chat first.',
        timeout: 3000
      });
    }
    return;
  }
  
  // Track which names were pseudonymized
  const pseudonymizedNames: Array<{ original: string; pseudonym: string }> = [];
  
  // Filter only Private AI messages and user messages (skip other AI providers)
  // Private AI is identified by providerKey === 'digitalocean'
  const messagesToFilterPrivateAI = messagesToFilter.filter(msg => {
    // Include user messages (they may contain names that need filtering)
    if (msg.role === 'user') {
      return true;
    }
    // Include only Private AI assistant messages
    if (msg.role === 'assistant') {
      // Check providerKey if available, otherwise check authorLabel or name
      const isPrivateAI = (msg as any).providerKey === 'digitalocean' || 
                          (msg as any).authorLabel === 'Private AI' ||
                          (msg as any).name === 'Private AI';
      return isPrivateAI;
    }
    return false;
  });
  
  // Create filtered messages by replacing names with pseudonyms
  // Only filter Private AI messages, keep others unchanged
  const filteredMessages: Message[] = messagesToFilter.map(msg => {
    // Skip filtering for non-Private AI messages
    const isUserMessage = msg.role === 'user';
    const isPrivateAI = msg.role === 'assistant' && 
                       ((msg as any).providerKey === 'digitalocean' || 
                        (msg as any).authorLabel === 'Private AI' ||
                        (msg as any).name === 'Private AI');
    
    if (!isUserMessage && !isPrivateAI) {
      // Return message unchanged for non-Private AI responses
      return msg;
    }
    
    let filteredContent = msg.content;
    
    // Build enhanced mappings that include variations with titles
    const enhancedMappings: Array<{ 
      original: string; 
      pseudonym: string; 
      lastName: string | null;
      lastNamePseudonym: string | null;
      isFullName: boolean;
    }> = [];
    // Match with or without period: Dr, Dr., Mr, Mr., etc.
    const titles = ['Dr\\.?', 'Mr\\.?', 'Mrs\\.?', 'Ms\\.?', 'Prof\\.?', 'RN', 'CNP', 'OD'];
    
    for (const mapping of privacyFilterMapping.value) {
      const original = mapping.original;
      const pseudonym = mapping.pseudonym;
      
      // Validate pseudonym before using it
      if (!pseudonym || typeof pseudonym !== 'string' || pseudonym.trim() === '') {
        continue; // Skip this mapping
      }
      
      // Extract last name if this is a full name
      const nameParts = original.split(/\s+/);
      const isFullName = nameParts.length >= 2;
      const lastName = isFullName ? nameParts[nameParts.length - 1] : null;
      
      // Find pseudonym for last name (if this is a full name, extract last name part from pseudonym)
      let lastNamePseudonym: string | null = null;
      if (isFullName && lastName) {
        const pseudonymParts = pseudonym.split(/\s+/);
        if (pseudonymParts.length >= 2) {
          lastNamePseudonym = pseudonymParts[pseudonymParts.length - 1]; // Last part of pseudonym
        }
      }
      
      enhancedMappings.push({ 
        original, 
        pseudonym, 
        lastName,
        lastNamePseudonym,
        isFullName
      });
    }
    
    // Sort by length (longest first) to avoid partial replacements
    // (e.g., "John Smith" before "John")
    enhancedMappings.sort((a, b) => b.original.length - a.original.length);
    
    // Track changes for full name replacements
    const beforeFullNameReplace = filteredContent;
    
    // Apply replacements for each mapping (full names first)
    for (const mapping of enhancedMappings) {
      // Normalize the original name: replace Unicode spaces with regular space
      const normalizedOriginal = mapping.original
        .replace(/\u202F/g, ' ')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Escape each word and join with \s+ so we match any whitespace (including U+202F, U+00A0) between first/last name.
      // This fixes "Dr. Wei Lien" not matching when the source has a narrow no-break space, which would leave only last-name replacement (e.g. "Dr. Wei Edwards89").
      const nameParts = normalizedOriginal.split(/\s+/).filter(Boolean);
      const escapedOriginal = nameParts
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
      const escapedOriginalWithUnicode =
        nameParts.length === 0
          ? escapedOriginal
          : mapping.original
              .split(/\s+/)
              .filter(Boolean)
              .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('\\s+');

      // Pattern 1: Exact match (case-insensitive, word boundaries, any whitespace between words)
      const exactPattern = new RegExp(`\\b${escapedOriginal}\\b`, 'gi');
      const exactPatternUnicode =
        escapedOriginal !== escapedOriginalWithUnicode
          ? new RegExp(`\\b${escapedOriginalWithUnicode}\\b`, 'gi')
          : null;

      // Pattern 1b: FirstName X. LastName (middle initial) so "Roger C. Pasinski" matches mapping "Roger Pasinski"
      if (nameParts.length >= 2) {
        const escapedFirst = nameParts[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedRest = nameParts.slice(1).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
        const middleInitialPattern = new RegExp(`\\b${escapedFirst}\\s+[A-Z]\\.\\s+${escapedRest}\\b`, 'gi');
        filteredContent = filteredContent.replace(middleInitialPattern, () => mapping.pseudonym);
      }
      
      // Try both patterns (normalized and with Unicode spaces)
      filteredContent = filteredContent.replace(exactPattern, (match, offset) => {
        // Check if this match is inside markdown formatting
        const before = filteredContent.substring(Math.max(0, offset - 10), offset);
        const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 10));
        
        // Check for markdown bold/italic before: ** or * or ##
        const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
        // Check for markdown after: ** or * or comma/age info
        const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
        
        if (hasMarkdownBefore || hasMarkdownAfter) {
          // Name is already inside markdown (e.g. **Name**). We only replace the
          // matched name; the ** before/after are outside the match and stay.
          // Return just the pseudonym so we get "... **" + pseudonym + "** ...".
          return mapping.pseudonym;
        }
        return mapping.pseudonym;
      });
      
      // Also try matching with Unicode spaces if different
      if (exactPatternUnicode) {
        filteredContent = filteredContent.replace(exactPatternUnicode, (match, offset) => {
          const before = filteredContent.substring(Math.max(0, offset - 10), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 10));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            return mapping.pseudonym;
          }
          return mapping.pseudonym;
        });
      }
      
      // Pattern 2: With titles (e.g., "Dr. Adrian Gropper", "Mr. Gropper")
      // Preserve the title in the replacement, and handle markdown
      // Use normalized original for matching
      for (const title of titles) {
        const titlePattern = new RegExp(`\\b${title}\\s+${escapedOriginal}\\b`, 'gi');
        const titlePatternUnicode = exactPatternUnicode 
          ? new RegExp(`\\b${title}\\s+${escapedOriginalWithUnicode}\\b`, 'gi')
          : null;
        
        filteredContent = filteredContent.replace(titlePattern, (match, offset) => {
          const titleMatch = match.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i);
          const replacement = titleMatch ? `${titleMatch[1]} ${mapping.pseudonym}` : mapping.pseudonym;
          
          // Check for markdown formatting
          const before = filteredContent.substring(Math.max(0, offset - 5), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            // Title+name is already inside markdown; only replace the matched span.
            return replacement;
          }
          return replacement;
        });
        
        // Also try with Unicode spaces
        if (titlePatternUnicode) {
          filteredContent = filteredContent.replace(titlePatternUnicode, (match, offset) => {
            const titleMatch = match.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i);
            const replacement = titleMatch ? `${titleMatch[1]} ${mapping.pseudonym}` : mapping.pseudonym;
            
            const before = filteredContent.substring(Math.max(0, offset - 5), offset);
            const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
            const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
            const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
            
            if (hasMarkdownBefore || hasMarkdownAfter) {
              return replacement;
            }
            return replacement;
          });
        }
      }
      
      // Pattern 3: Names in markdown formatting (e.g., "**Adrian Gropper, 73 M**")
      // This handles the full markdown-wrapped name
      // Use normalized version for matching
      const markdownPatterns = [
        new RegExp(`\\*\\*${escapedOriginal}([^\\*]*?)\\*\\*`, 'gi'), // **Name, info**
        new RegExp(`\\*${escapedOriginal}([^\\*]*?)\\*`, 'gi'), // *Name, info*
        new RegExp(`##\\s+${escapedOriginal}(.*?)(?:\\n|$)`, 'gi'), // ## Name info
      ];
      
      // Also create patterns for Unicode version if different
      const markdownPatternsUnicode = exactPatternUnicode ? [
        new RegExp(`\\*\\*${escapedOriginalWithUnicode}([^\\*]*?)\\*\\*`, 'gi'),
        new RegExp(`\\*${escapedOriginalWithUnicode}([^\\*]*?)\\*`, 'gi'),
        new RegExp(`##\\s+${escapedOriginalWithUnicode}(.*?)(?:\\n|$)`, 'gi'),
      ] : [];
      
      for (const mdPattern of markdownPatterns) {
        filteredContent = filteredContent.replace(mdPattern, (match, suffix) => {
          // Preserve the markdown formatting and any suffix (like ", 73 M")
          if (match.startsWith('**')) {
            return `**${mapping.pseudonym}${suffix || ''}**`;
          } else if (match.startsWith('*')) {
            return `*${mapping.pseudonym}${suffix || ''}*`;
          } else if (match.startsWith('##')) {
            return `## ${mapping.pseudonym}${suffix || ''}`;
          }
          return mapping.pseudonym + (suffix || '');
        });
      }
      
      // Also try Unicode patterns
      for (const mdPattern of markdownPatternsUnicode) {
        filteredContent = filteredContent.replace(mdPattern, (match, suffix) => {
          if (match.startsWith('**')) {
            return `**${mapping.pseudonym}${suffix || ''}**`;
          } else if (match.startsWith('*')) {
            return `*${mapping.pseudonym}${suffix || ''}*`;
          } else if (match.startsWith('##')) {
            return `## ${mapping.pseudonym}${suffix || ''}`;
          }
          return mapping.pseudonym + (suffix || '');
        });
      }
    }
    
    // Track which full names were replaced
    if (beforeFullNameReplace !== filteredContent) {
      for (const mapping of enhancedMappings) {
        const escapedOriginal = mapping.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const testPattern = new RegExp(`\\b${escapedOriginal}\\b`, 'gi');
        if (testPattern.test(beforeFullNameReplace) && !pseudonymizedNames.some(n => n.original === mapping.original)) {
          pseudonymizedNames.push({ original: mapping.original, pseudonym: mapping.pseudonym });
        }
      }
    }
    
    // Second pass: Process last names only (for full names that were mapped)
    // This avoids replacing last names that are part of already-replaced full names
    const lastNameMappings: Array<{ lastName: string; lastNamePseudonym: string; normalizedLastName: string }> = [];
    for (const mapping of enhancedMappings) {
      if (mapping.isFullName && mapping.lastName && mapping.lastNamePseudonym) {
        // Normalize last name (handle Unicode spaces)
        const normalizedLastName = mapping.lastName
          .replace(/\u202F/g, ' ')
          .replace(/\u00A0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        // Check if this last name mapping is unique (by normalized name)
        if (!lastNameMappings.some(m => m.normalizedLastName.toLowerCase() === normalizedLastName.toLowerCase())) {
          lastNameMappings.push({
            lastName: mapping.lastName,
            lastNamePseudonym: mapping.lastNamePseudonym,
            normalizedLastName: normalizedLastName
          });
        }
      }
    }
    
    // Apply last name replacements (only if they haven't been replaced as part of full names)
    for (const lastNameMapping of lastNameMappings) {
      // Use normalized last name for matching
      const escapedLastName = lastNameMapping.normalizedLastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedLastNameUnicode = lastNameMapping.lastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      // Match standalone last name (with word boundaries, case-insensitive)
      // Also handle markdown formatting
      // Try both normalized and Unicode versions
      const lastNamePattern = new RegExp(`\\b${escapedLastName}\\b`, 'gi');
      const lastNamePatternUnicode = escapedLastName !== escapedLastNameUnicode
        ? new RegExp(`\\b${escapedLastNameUnicode}\\b`, 'gi')
        : null;
      
      filteredContent = filteredContent.replace(lastNamePattern, (match, offset) => {
        // Check if this is part of a pseudonym (has numbers nearby) - if so, skip
        const before = filteredContent.substring(Math.max(0, offset - 5), offset);
        const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
        if (/\d/.test(before + after)) {
          return match; // Part of pseudonym, don't replace
        }
        
        // Check for markdown formatting
        const beforeFull = filteredContent.substring(Math.max(0, offset - 10), offset);
        const afterFull = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 10));
        const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(beforeFull);
        const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(afterFull);
        
        if (hasMarkdownBefore || hasMarkdownAfter) {
          return lastNameMapping.lastNamePseudonym;
        }
        
        return lastNameMapping.lastNamePseudonym;
      });
      
      // Also try Unicode version
      if (lastNamePatternUnicode) {
        filteredContent = filteredContent.replace(lastNamePatternUnicode, (match, offset) => {
          const before = filteredContent.substring(Math.max(0, offset - 5), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
          if (/\d/.test(before + after)) {
            return match;
          }
          
          const beforeFull = filteredContent.substring(Math.max(0, offset - 10), offset);
          const afterFull = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 10));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(beforeFull);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(afterFull);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            return lastNameMapping.lastNamePseudonym;
          }
          
          return lastNameMapping.lastNamePseudonym;
        });
      }
      
      // Match last name with titles
      for (const title of titles) {
        const titleLastNamePattern = new RegExp(`\\b${title}\\s+${escapedLastName}\\b`, 'gi');
        const titleLastNamePatternUnicode = lastNamePatternUnicode
          ? new RegExp(`\\b${title}\\s+${escapedLastNameUnicode}\\b`, 'gi')
          : null;
        filteredContent = filteredContent.replace(titleLastNamePattern, (match, offset) => {
          const titleMatch = match.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i);
          const replacement = titleMatch ? `${titleMatch[1]} ${lastNameMapping.lastNamePseudonym}` : lastNameMapping.lastNamePseudonym;
          
          // Check for markdown formatting
          const before = filteredContent.substring(Math.max(0, offset - 5), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            return replacement;
          }
          return replacement;
        });
        
        // Also try Unicode version
        if (titleLastNamePatternUnicode) {
          filteredContent = filteredContent.replace(titleLastNamePatternUnicode, (match, offset) => {
            const titleMatch = match.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|RN|CNP|OD)\s+/i);
            const replacement = titleMatch ? `${titleMatch[1]} ${lastNameMapping.lastNamePseudonym}` : lastNameMapping.lastNamePseudonym;
            
            const before = filteredContent.substring(Math.max(0, offset - 5), offset);
            const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
            const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
            const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
            
            if (hasMarkdownBefore || hasMarkdownAfter) {
              return replacement;
            }
            return replacement;
          });
        }
      }
      
      // Match "Mr./Ms. LastName" format (with period)
      const titlePeriodPattern = new RegExp(`\\b(Mr|Ms|Mrs|Dr|Prof)\\.\\s+${escapedLastName}\\b`, 'gi');
      const titlePeriodPatternUnicode = lastNamePatternUnicode
        ? new RegExp(`\\b(Mr|Ms|Mrs|Dr|Prof)\\.\\s+${escapedLastNameUnicode}\\b`, 'gi')
        : null;
      filteredContent = filteredContent.replace(titlePeriodPattern, (match, offset) => {
        const titleMatch = match.match(/^(Mr|Ms|Mrs|Dr|Prof)\./i);
        const replacement = titleMatch ? `${titleMatch[1]}. ${lastNameMapping.lastNamePseudonym}` : lastNameMapping.lastNamePseudonym;
        
        // Check for markdown formatting
        const before = filteredContent.substring(Math.max(0, offset - 5), offset);
        const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
        const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
        const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
        
        if (hasMarkdownBefore || hasMarkdownAfter) {
          return replacement;
        }
        return replacement;
      });
      
      // Also try Unicode version
      if (titlePeriodPatternUnicode) {
        filteredContent = filteredContent.replace(titlePeriodPatternUnicode, (match, offset) => {
          const titleMatch = match.match(/^(Mr|Ms|Mrs|Dr|Prof)\./i);
          const replacement = titleMatch ? `${titleMatch[1]}. ${lastNameMapping.lastNamePseudonym}` : lastNameMapping.lastNamePseudonym;
          
          const before = filteredContent.substring(Math.max(0, offset - 5), offset);
          const after = filteredContent.substring(offset + match.length, Math.min(filteredContent.length, offset + match.length + 5));
          const hasMarkdownBefore = /(\*\*|\*|##)\s*$/.test(before);
          const hasMarkdownAfter = /^\s*(\*\*|\*|,)/.test(after);
          
          if (hasMarkdownBefore || hasMarkdownAfter) {
            return replacement;
          }
          return replacement;
        });
      }
      
      // Pattern for last names in markdown formatting (e.g., "**Mr. Gropper**")
      const lastNameMarkdownPatterns = [
        new RegExp(`\\*\\*([^\\*]*?\\s+)?${escapedLastName}([^\\*]*?)\\*\\*`, 'gi'), // **prefix LastName suffix**
        new RegExp(`\\*([^\\*]*?\\s+)?${escapedLastName}([^\\*]*?)\\*`, 'gi'), // *prefix LastName suffix*
      ];
      
      for (const mdPattern of lastNameMarkdownPatterns) {
        filteredContent = filteredContent.replace(mdPattern, (match, prefix, suffix) => {
          const prefixText = prefix || '';
          const suffixText = suffix || '';
          if (match.startsWith('**')) {
            return `**${prefixText}${lastNameMapping.lastNamePseudonym}${suffixText}**`;
          } else if (match.startsWith('*')) {
            return `*${prefixText}${lastNameMapping.lastNamePseudonym}${suffixText}*`;
          }
          return prefixText + lastNameMapping.lastNamePseudonym + suffixText;
        });
      }
    }
    
    return {
      ...msg,
      content: filteredContent
    };
  });
  
  // Check if any names were actually replaced
  const namesReplaced = pseudonymizedNames.length > 0;
  
  // Compare filtered messages with original to see if anything changed
  let hasChanges = false;
  for (let i = 0; i < filteredMessages.length && i < messagesToFilter.length; i++) {
    if (filteredMessages[i].content !== messagesToFilter[i].content) {
      hasChanges = true;
      break;
    }
  }
  
  // Check if messages might already be filtered (contain pseudonyms with numbers)
  const mightBeFiltered = messagesToFilter.some(msg => {
    // Check if message contains patterns like "Name45" or "Name67" (pseudonym pattern)
    return /\b[A-Z][a-z]+\d{2}\s+[A-Z][a-z]+\d{2}\b/.test(msg.content);
  });
  
  if (!hasChanges && !namesReplaced) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'info',
        message: mightBeFiltered 
          ? 'Messages appear to already be filtered. Use truly original messages to re-filter.'
          : 'No names found to replace in messages. They may not be present in the current chat.',
        timeout: 4000
      });
    }
    return;
  }
  
  // Emit filtered messages to parent component
  emit('messages-filtered', filteredMessages);
  
  const namesList = pseudonymizedNames.map(n => `${n.original} → ${n.pseudonym}`).join(', ');
  
  // Show warning modal after filtering
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Privacy Filter Applied',
      message: 'Privacy filtering can miss sensitive information. Always review the result and use the Edit function to make further changes to the chat before sharing.',
      persistent: false,
      ok: {
        label: 'OK',
        color: 'primary',
        flat: false
      }
    }).onOk(() => {
      // Close Privacy Filter tab and My Stuff dialog
      currentTab.value = 'files'; // Switch to a different tab
      closeDialog(); // Close My Stuff dialog
    });
  }
  
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: `Filtered ${messagesToFilterPrivateAI.length} Private AI message(s). Replaced: ${namesList || 'names'}`,
      timeout: 3000
    });
  }
};

const loadDiary = async () => {
  loadingDiary.value = true;
  diaryError.value = '';

  const url = `/api/patient-diary?userId=${encodeURIComponent(props.userId)}`;
  try {
    const response = await fetch(url, {
      credentials: 'include'
    });
    if (!response.ok) {
      diaryEntries.value = [];
      loadingDiary.value = false;
      return;
    }
    
    const result = await response.json();
    diaryEntries.value = result.entries || [];
    
    // Assign bubbleIds to entries that don't have them
    // Group entries sequentially, but respect closed bubbles
    let currentBubbleId: string | null = null;
    for (const entry of diaryEntries.value) {
      if (!entry.bubbleId) {
        // Entry doesn't have a bubbleId - assign one
        if (currentBubbleId && !closedBubbleIds.value.has(currentBubbleId)) {
          // Last bubble is open - add to it
          entry.bubbleId = currentBubbleId;
        } else {
          // No bubble or last bubble is closed - create new bubble
          currentBubbleId = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          entry.bubbleId = currentBubbleId;
        }
      } else {
        // Entry has a bubbleId - use it as current
        currentBubbleId = entry.bubbleId;
      }
    }
    
    // Load closed bubble IDs from entries that have bubbleId and are posted
    // Mark bubbles as closed if any entry in the bubble is posted
    const bubbleMap = new Map<string, boolean>();
    for (const entry of diaryEntries.value) {
      if (entry.bubbleId) {
        const hasPosted = entry.posted === true;
        if (!bubbleMap.has(entry.bubbleId)) {
          bubbleMap.set(entry.bubbleId, hasPosted);
        } else {
          bubbleMap.set(entry.bubbleId, bubbleMap.get(entry.bubbleId) || hasPosted);
        }
      }
    }
    closedBubbleIds.value = new Set(
      Array.from(bubbleMap.entries())
        .filter(([_, hasPosted]) => hasPosted)
        .map(([bubbleId, _]) => bubbleId)
    );
    
    // Scroll to bottom after loading
    await nextTick();
    if (diaryMessagesRef.value) {
      diaryMessagesRef.value.scrollTop = diaryMessagesRef.value.scrollHeight;
    }
  } catch (err) {
    diaryError.value = err instanceof Error ? err.message : 'Failed to load diary';
  } finally {
    loadingDiary.value = false;
  }
};

const addDiaryEntry = async () => {
  const message = diaryInputText.value.trim();
  if (!message || isSavingDiary.value) {
    return;
  }

  isSavingDiary.value = true;

  try {
    const dateTime = new Date().toISOString();
    
    // Determine which bubble this entry belongs to BEFORE creating it
    // If the last bubble is closed, create a new bubble. Otherwise, add to the last bubble.
    let bubbleId: string;
    if (diaryBubbles.value.length > 0) {
      const lastBubble = diaryBubbles.value[diaryBubbles.value.length - 1];
      if (lastBubble.closed) {
        // Last bubble is closed - create new bubble
        bubbleId = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      } else {
        // Last bubble is open - add to it
        bubbleId = lastBubble.id;
      }
    } else {
      // No bubbles yet - create first bubble
      bubbleId = `bubble-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    const entryData = {
      message,
      dateTime,
      bubbleId
    };

    const postUrl = '/api/patient-diary';
    const response = await fetch(postUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        entry: entryData
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(errorData.error || 'Failed to save diary entry');
    }

    const result = await response.json();
    
    // Add the new entry to the list with its bubbleId
    const newEntry = {
      id: result.entryId,
      message,
      dateTime,
      bubbleId
    };
    diaryEntries.value.push(newEntry);

    // Clear input
    diaryInputText.value = '';

    // Scroll to bottom to show new entry
    await nextTick();
    if (diaryMessagesRef.value) {
      diaryMessagesRef.value.scrollTop = diaryMessagesRef.value.scrollHeight;
    }

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Diary entry saved',
        timeout: 2000
      });
    }
  } catch (error) {
    console.error('[Diary] Error saving entry:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to save diary entry',
        timeout: 3000
      });
    }
  } finally {
    isSavingDiary.value = false;
  }
};

// Track which bubbles have been closed (posted)
const closedBubbleIds = ref<Set<string>>(new Set());

// Group diary entries into bubbles by bubbleId
// Each entry has a bubbleId. Group entries by their bubbleId.
const diaryBubbles = computed(() => {
  if (diaryEntries.value.length === 0) {
    return [];
  }

  // Group entries by bubbleId
  const bubbleMap = new Map<string, Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>>();
  
  for (const entry of diaryEntries.value) {
    const bubbleId = entry.bubbleId || 'no-bubble-id';
    if (!bubbleMap.has(bubbleId)) {
      bubbleMap.set(bubbleId, []);
    }
    bubbleMap.get(bubbleId)!.push(entry);
  }

  // Convert to bubble array, sorted by first entry's dateTime
  const bubbles: Array<{ 
    id: string;
    entries: Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>; 
    lastDateTime: string;
    closed: boolean;
  }> = [];

  for (const [bubbleId, entries] of bubbleMap.entries()) {
    // Sort entries by dateTime
    const sortedEntries = [...entries].sort((a, b) => 
      new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime()
    );
    
    const lastDateTime = sortedEntries[sortedEntries.length - 1]?.dateTime || '';
    const isClosed = closedBubbleIds.value.has(bubbleId);
    
    bubbles.push({
      id: bubbleId,
      entries: sortedEntries,
      lastDateTime,
      closed: isClosed
    });
  }

  // Sort bubbles by first entry's dateTime
  bubbles.sort((a, b) => {
    const dateA = new Date(a.entries[0]?.dateTime || 0);
    const dateB = new Date(b.entries[0]?.dateTime || 0);
    return dateA.getTime() - dateB.getTime();
  });

  return bubbles;
});

const formatDiaryDateTime = (dateTimeString: string): string => {
  const date = new Date(dateTimeString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  // Format: "Today at 3:45 PM" or "Yesterday at 2:30 PM" or "Jan 15, 2025 at 10:30 AM"
  const timeStr = date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
  
  if (diffMins < 1) {
    return `Just now`;
  } else if (diffMins < 60) {
    return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  } else if (diffDays === 0) {
    return `Today at ${timeStr}`;
  } else if (diffDays === 1) {
    return `Yesterday at ${timeStr}`;
  } else {
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
    return `${dateStr} at ${timeStr}`;
  }
};

const formatDiaryTime = (dateTimeString: string): string => {
  const date = new Date(dateTimeString);
  return date.toLocaleTimeString('en-US', { 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
};

const postBubbleToChat = (bubble: { id: string; entries: Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>; lastDateTime: string; closed: boolean }) => {
  // Format the bubble content
  const bubbleContent = bubble.entries
    .map(entry => {
      const time = formatDiaryTime(entry.dateTime);
      return `${time} ${entry.message}`;
    })
    .join('\n');
  
  const diaryMessage = `Here is my latest patient diary:\n\n${bubbleContent}`;
  
  // Emit to parent to add to chat
  emit('diary-posted', diaryMessage);
  
  // Mark this bubble as closed by adding its bubble ID to closedBubbleIds
  // This marks the bubble as closed so the next message starts a new bubble
  closedBubbleIds.value.add(bubble.id);
  
  // Also update local entries (for backend persistence)
  bubble.entries.forEach(entry => {
    const localEntry = diaryEntries.value.find(e => e.id === entry.id);
    if (localEntry) {
      localEntry.posted = true;
    }
  });
  
  // Update backend to mark entries as posted
  updateDiaryEntriesPosted(bubble.entries.map(e => e.id));
  
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Diary posted to chat',
      timeout: 2000
    });
  }
};

const updateDiaryEntriesPosted = async (entryIds: string[]) => {
  try {
    await fetch('/api/patient-diary/mark-posted', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        entryIds
      })
    });
  } catch (error) {
    console.error('[Diary] Error marking entries as posted:', error);
  }
};

// Shared References Functions
const loadReferences = async () => {
  loadingReferences.value = true;
  referencesError.value = '';

  try {
    const response = await fetch(`/api/user-files?userId=${props.userId}&subfolder=References`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch references: ${response.statusText}`);
    }

    const result = await response.json();
    referenceFiles.value = (result.files || []).map((file: any) => ({
      fileName: file.fileName,
      bucketKey: file.bucketKey,
      fileSize: file.fileSize,
      uploadedAt: file.uploadedAt,
      fileType: file.fileType,
      fileUrl: file.fileUrl
    }));
  } catch (err) {
    referencesError.value = err instanceof Error ? err.message : 'Failed to load references';
  } finally {
    loadingReferences.value = false;
  }
};

const triggerReferenceFileInput = () => {
  referenceFileInput.value?.click();
};

const handleReferenceFileSelect = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  
  if (!file) return;

  isUploadingReference.value = true;

  try {
    // Check file size
    const maxSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxSize) {
      throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum size is 50MB.`);
    }

    // Upload to References subfolder
    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('subfolder', 'References');

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
    try {
      const isAppleHealth = String(uploadResult.fileInfo.fileName || '').toLowerCase().endsWith('.pdf')
        ? await detectAppleHealthFromBucket(uploadResult.fileInfo.bucketKey)
        : false;
      await fetch('/api/user-file-metadata', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          userId: props.userId,
          fileMetadata: {
            fileName: uploadResult.fileInfo.fileName,
            bucketKey: uploadResult.fileInfo.bucketKey,
            bucketPath: uploadResult.fileInfo.userFolder,
            fileSize: uploadResult.fileInfo.size,
            fileType: file.name.endsWith('.pdf') ? 'pdf' : (file.name.endsWith('.md') ? 'markdown' : 'text'),
            uploadedAt: uploadResult.fileInfo.uploadedAt,
            isAppleHealth: isAppleHealth,
            isReference: true // Mark as reference file
          }
        })
      });
    } catch (error) {
      console.warn('Failed to save file metadata to user document:', error);
    }

    // Reload references list
    await loadReferences();

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Reference file uploaded successfully',
        timeout: 2000
      });
    }
  } catch (error) {
    console.error('Error uploading reference file:', error);
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: error instanceof Error ? error.message : 'Failed to upload reference file',
        timeout: 3000
      });
    }
  } finally {
    isUploadingReference.value = false;
    // Reset input
    if (input) {
      input.value = '';
    }
  }
};

const viewReferenceFile = (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }) => {
  // Use the same PDF viewer modal as other files
  if (file.fileType === 'pdf' && file.bucketKey) {
    viewFileInPdfViewer({
      fileName: file.fileName,
      bucketKey: file.bucketKey,
      fileSize: file.fileSize,
      uploadedAt: file.uploadedAt,
      inKnowledgeBase: false
    });
  } else {
    // For text files, use PDF viewer modal (it can handle text too)
    viewFileInPdfViewer({
      fileName: file.fileName,
      bucketKey: file.bucketKey,
      fileSize: file.fileSize,
      uploadedAt: file.uploadedAt,
      inKnowledgeBase: false
    });
  }
};

const deleteReferenceFile = async (file: { fileName: string; bucketKey: string }) => {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Delete Reference File',
      message: `Are you sure you want to delete "${file.fileName}"?`,
      persistent: true,
      ok: {
        label: 'Delete',
        color: 'negative',
        flat: false
      },
      cancel: {
        label: 'Cancel',
        color: 'grey',
        flat: true
      }
    }).onOk(async () => {
      try {
        const response = await fetch('/api/files/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            bucketKey: file.bucketKey
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to delete file');
        }

        // Remove from list
        referenceFiles.value = referenceFiles.value.filter(f => f.bucketKey !== file.bucketKey);

        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'positive',
            message: 'Reference file deleted successfully',
            timeout: 2000
          });
        }
      } catch (error) {
        console.error('Error deleting reference file:', error);
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: error instanceof Error ? error.message : 'Failed to delete reference file',
            timeout: 3000
          });
        }
      }
    });
  }
};

const showAddReferenceToChatDialog = (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }) => {
  selectedReferenceForChat.value = file;
  
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Add Reference to Chat',
      message: `Would you like to add "${file.fileName}" to the current chat? Reference files are not considered for indexing in the patient's knowledge base.`,
      persistent: true,
      ok: {
        label: 'ADD TO CHAT',
        color: 'primary',
        flat: false
      },
      cancel: {
        label: 'CANCEL',
        color: 'grey',
        flat: true
      }
    }).onOk(() => {
      addReferenceToChat(file);
    }).onCancel(() => {
      selectedReferenceForChat.value = null;
    }).onDismiss(() => {
      selectedReferenceForChat.value = null;
    });
  }
};

const addReferenceToChat = (file: { fileName: string; bucketKey: string; fileSize: number; uploadedAt: string; fileType?: string; fileUrl?: string }) => {
  // Emit event to add file to chat
  emit('reference-file-added', {
    fileName: file.fileName,
    bucketKey: file.bucketKey,
    fileSize: file.fileSize,
    uploadedAt: file.uploadedAt,
    fileType: file.fileType || 'text',
    fileUrl: file.fileUrl,
    isReference: true
  });
  
  selectedReferenceForChat.value = null;
  
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Reference file added to chat',
      timeout: 2000
    });
  }
};

const deleteBubble = async (bubble: { id: string; entries: Array<{ id: string; message: string; dateTime: string; posted?: boolean; bubbleId?: string }>; lastDateTime: string; closed: boolean }) => {
  if ($q && typeof $q.dialog === 'function') {
    $q.dialog({
      title: 'Delete Diary Bubble',
      message: `Are you sure you want to delete this diary bubble with ${bubble.entries.length} entr${bubble.entries.length === 1 ? 'y' : 'ies'}?`,
      persistent: true,
      ok: {
        label: 'Delete',
        color: 'negative',
        flat: false
      },
      cancel: {
        label: 'Cancel',
        color: 'grey',
        flat: true
      }
    }).onOk(async () => {
      try {
        const entryIds = bubble.entries.map(e => e.id);
        
        const response = await fetch('/api/patient-diary/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            entryIds
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
          throw new Error(errorData.error || 'Failed to delete diary entries');
        }

        // Remove entries from local state
        diaryEntries.value = diaryEntries.value.filter(entry => !entryIds.includes(entry.id));
        
        // Also remove from closed bubble set
        if (closedBubbleIds.value.has(bubble.id)) {
          closedBubbleIds.value.delete(bubble.id);
        }

        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'positive',
            message: 'Diary bubble deleted',
            timeout: 2000
          });
        }
      } catch (error) {
        console.error('[Diary] Error deleting bubble:', error);
        if ($q && typeof $q.notify === 'function') {
          $q.notify({
            type: 'negative',
            message: error instanceof Error ? error.message : 'Failed to delete diary bubble',
            timeout: 3000
          });
        }
      }
    });
  }
};

const loadPatientSummary = async () => {
  loadingSummary.value = true;
  summaryError.value = '';

  try {
    const response = await fetch(`/api/patient-summary?userId=${encodeURIComponent(props.userId)}`, {
      credentials: 'include'
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch patient summary: ${response.statusText}`);
    }
    
    const result = await response.json();
    const loadedSummary = result.summary || '';
    patientSummary.value = loadedSummary;
    summaryEditText.value = loadedSummary;
    patientSummaries.value = result.summaries || [];
    if (!loadedSummary) {
      isEditingSummaryTab.value = false;
    }
  } catch (err) {
    summaryError.value = err instanceof Error ? err.message : 'Failed to load patient summary';
  } finally {
    loadingSummary.value = false;
  }
};

const requestNewSummary = async () => {
  // Always proceed directly - no pre-generation confirmation
  // If slots are full, the replace dialog will show after generation
  loadingSummary.value = true;
  summaryError.value = '';

  try {
    const response = await fetch('/api/generate-patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to generate patient summary');
    }

    const result = await response.json();

    // Use server's summary count (from generate response) so we don't rely on stale client state
    const summaryCount = result.summaries?.length ?? patientSummaries.value.length;
    const hasEmptySlots = summaryCount < 3;
    
    if (hasEmptySlots) {
      // Automatically save with 'newest' strategy (just adds to array)
      await handleReplaceSummary('newest', (result.summary || '').trim());
    } else {
      // All slots full - show dialog to choose which summary to replace
      savedCurrentSummaryForUndo.value = result.savedCurrentSummary || null;
      newSummaryToReplace.value = (result.summary || '').trim();
      showReplaceSummaryDialog.value = true;
    }
  } catch (error) {
    console.error('Error generating patient summary:', error);
    summaryError.value = error instanceof Error ? error.message : 'Failed to generate patient summary';
    
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: summaryError.value,
        timeout: 5000
      });
    }
  } finally {
    loadingSummary.value = false;
  }
};


const startSummaryEdit = () => {
  summaryEditText.value = patientSummary.value || '';
  isEditingSummaryTab.value = true;
};

const cancelSummaryEdit = () => {
  isEditingSummaryTab.value = false;
  summaryEditText.value = '';
};

/**
 * Extract the "Current Medications" section from a Patient Summary text.
 * Looks for headings like "Current Medications", "## Current Medications", "**Current Medications**".
 * Returns the text from that heading to the next heading, or null if not found.
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

const saveSummaryFromTab = async () => {
  if (!props.userId) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message: 'User ID is required to save the summary'
      });
    }
    return;
  }

  const summaryToSave = summaryEditText.value.trim();
  if (!summaryToSave) {
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'warning',
        message: 'Summary cannot be empty'
      });
    }
    return;
  }

  isSavingSummary.value = true;

  try {
    const response = await fetch('/api/patient-summary', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        userId: props.userId,
        summary: summaryToSave
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || 'Failed to save patient summary');
    }

    patientSummary.value = summaryToSave;
    newPatientSummary.value = summaryToSave;
    summaryViewText.value = summaryToSave;
    summaryEditText.value = summaryToSave;
    isEditingSummaryTab.value = false;
    emit('patient-summary-saved', { userId: props.userId });

    // Extract Current Medications from Patient Summary and save automatically
    try {
      const medsText = extractMedicationsFromSummary(summaryToSave);
      if (medsText) {
        await fetch('/api/user-current-medications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            userId: props.userId,
            currentMedications: medsText
          })
        });
        emit('current-medications-saved', { value: medsText, edited: false });
      }
    } catch (medsError) {
      console.warn('Failed to auto-save medications from summary:', medsError);
    }

    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'positive',
        message: 'Patient summary saved successfully!'
      });
    }
  } catch (error) {
    console.error('Error saving summary:', error);
    const message = error instanceof Error ? error.message : 'Failed to save patient summary';
    if ($q && typeof $q.notify === 'function') {
      $q.notify({
        type: 'negative',
        message
      });
    }
  } finally {
    isSavingSummary.value = false;
  }
};

const handleVerifySummaryTab = () => {
  if (!props.userId || !patientSummary.value) return;
  summaryNeedsVerify.value = false;
  emit('patient-summary-verified', { userId: props.userId });
  if ($q && typeof $q.notify === 'function') {
    $q.notify({
      type: 'positive',
      message: 'Patient summary verified.'
    });
  }
};

const sortedSharedChats = computed(() => {
  return [...sharedChats.value].sort((a, b) => {
    const dateA = new Date(a.updatedAt || a.createdAt);
    const dateB = new Date(b.updatedAt || b.createdAt);
    return dateB.getTime() - dateA.getTime();
  });
});

const closeDialog = async (): Promise<boolean> => {
  // Check if indexing is in progress
  if (indexingKB.value && currentIndexingJobId.value) {
    const result = await new Promise<'ok' | 'cancel' | 'dismiss'>((resolve) => {
      if ($q && typeof $q.dialog === 'function') {
        $q.dialog({
          title: 'Indexing in progress',
          message: 'Knowledge base indexing is still in progress and could take up to 60 minutes. What would you like to do?',
          persistent: true,
          ok: {
            label: 'OK',
            color: 'primary',
            flat: false
          },
          cancel: {
            label: 'Cancel Indexing',
            color: 'negative',
            flat: true
          }
        }).onOk(() => resolve('ok'))
          .onCancel(() => resolve('cancel'))
          .onDismiss(() => resolve('dismiss'));
      } else {
        const action = window.confirm('Indexing is in progress. Click OK to continue watching, or Cancel to cancel indexing.');
        resolve(action ? 'ok' : 'cancel');
      }
    });

    if (result === 'cancel') {
      // Cancel indexing and restore files
      await cancelIndexingAndRestore();
      // After cancel, allow closing
    } else if (result === 'ok' || result === 'dismiss') {
      // User wants to stay and watch - don't close
      return false;
    }
  }

  if (hasUnsavedChanges.value) {
    const confirmClose = await new Promise<boolean>((resolve) => {
      if ($q && typeof $q.dialog === 'function') {
        $q.dialog({
          title: 'Unsaved changes',
          message: 'You have unsaved changes in My Agent or Patient Summary. Close without saving?',
          cancel: true,
          persistent: true,
          ok: {
            label: 'Discard and Close',
            color: 'negative'
          }
        }).onOk(() => resolve(true))
          .onCancel(() => resolve(false))
          .onDismiss(() => resolve(false));
      } else {
        const shouldClose = window.confirm('You have unsaved changes in My Agent or Patient Summary. Close without saving?');
        resolve(shouldClose);
      }
    });

    if (!confirmClose) {
      return false;
    }

    if (hasUnsavedAgentChanges.value) {
      cancelEdit();
    }

    if (hasUnsavedSummaryChanges.value) {
      cancelSummaryEdit();
    }
  }

  isOpen.value = false;
  return true;
};

watch(() => props.modelValue, async (newValue) => {
  isOpen.value = newValue;
  if (newValue) {
    // Set initial tab if provided
    if (props.initialTab) {
      currentTab.value = props.initialTab;
    }
    
    // Check for active indexing job and restore polling if needed
    try {
      const statusResponse = await fetch(`/api/user-files?userId=${encodeURIComponent(props.userId)}`, {
        credentials: 'include'
      });
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        const jobId = statusData.kbIndexingJobId || statusData.kbLatestJobId || null;
        if (statusData.kbIndexingActive && jobId && !currentIndexingJobId.value) {
          try {
            const jobStatusResponse = await fetch(`/api/kb-indexing-status/${jobId}?userId=${encodeURIComponent(props.userId)}`, {
              credentials: 'include'
            });
            if (jobStatusResponse.ok) {
              const jobStatusData = await jobStatusResponse.json();
              if (jobStatusData.phase && jobStatusData.phase !== 'complete' && jobStatusData.phase !== 'error') {
                currentIndexingJobId.value = jobId;
                indexingKB.value = true;
                indexingStatus.value = {
                  phase: jobStatusData.phase || 'indexing',
                  message: jobStatusData.message || 'Indexing in progress...',
                  kb: jobStatusData.kb || statusData.kbId || '',
                  tokens: jobStatusData.tokens || '0',
                  filesIndexed: jobStatusData.filesIndexed || 0,
                  progress: jobStatusData.progress || 0,
                  error: jobStatusData.error || ''
                };
                pollIndexingProgress(jobId);
              }
            }
          } catch (jobStatusError) {
            console.warn('Failed to check job status on dialog open:', jobStatusError);
          }
        }
      }
    } catch (statusError) {
      console.warn('Failed to check indexing status on dialog open:', statusError);
    }
    
    // Load data when dialog opens
    if (currentTab.value === 'files') {
      loadFiles();
    } else if (currentTab.value === 'agent') {
      loadAgent();
    } else if (currentTab.value === 'chats') {
      loadSharedChats();
    } else if (currentTab.value === 'privacy') {
      loadPrivacyFilter();
    } else if (currentTab.value === 'diary') {
      loadDiary();
    } else if (currentTab.value === 'references') {
      loadReferences();
    } else if (currentTab.value === 'lists') {
      // Wizard may have set sessionStorage flags after Lists component was already mounted;
      // re-trigger wizard auto-flow detection so it picks up the new flags.
      nextTick(() => {
        if (listsComponentRef.value) {
          listsComponentRef.value.loadWizardAutoFlow();
          listsComponentRef.value.attemptAutoProcessInitialFile();
        }
      });
    } else if (currentTab.value === 'summary' && props.requestSummaryOnOpen) {
      // Wizard asked for one summary generation on open (avoids duplicate API call)
      // Set loadingSummary immediately to prevent flash of empty state
      loadingSummary.value = true;
      nextTick(() => {
        setTimeout(() => {
          requestNewSummary();
          emit('request-summary-done');
        }, 300);
      });
    }

  }
});

watch(() => props.initialTab, (newTab) => {
  if (newTab && isOpen.value) {
    currentTab.value = newTab;
  }
});

watch(isOpen, (newValue) => {
  emit('update:modelValue', newValue);
  if (!newValue) {
    if (pollingInterval.value) {
      clearInterval(pollingInterval.value);
      pollingInterval.value = null;
    }
    if (elapsedTimeInterval.value) {
      clearInterval(elapsedTimeInterval.value);
      elapsedTimeInterval.value = null;
    }
  }
});

const listsComponentRef = ref<InstanceType<typeof Lists> | null>(null);

watch(currentTab, async (newTab) => {
  if (newTab === 'privacy') {
    if (privacyFilterMapping.value.length > 0) {
      const current = privacyFilterMapping.value;
      const getCanonical = (orig: string) =>
        toCanonical(orig, buildLastNameToFullNameFromFullNames(current.map(m => m.original)));
      const { deduplicated, removed } = deduplicateMapping(current, getCanonical);
      const cleaned = dropOrphanFirstNames(deduplicated);
      if (removed.length > 0 || cleaned.length !== current.length) {
        privacyFilterMapping.value = cleaned;
        try {
          await fetch('/api/privacy-filter-mapping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ mapping: cleaned })
          });
        } catch (saveErr) {
          // Silently handle save errors
        }
      }
    }

    loadPrivacyFilter();
  } else if (isOpen.value) {
    if (newTab === 'files') {
      loadFiles();
    } else if (newTab === 'agent') {
      loadAgent();
    } else if (newTab === 'chats') {
      loadSharedChats();
    } else if (newTab === 'summary') {
      loadPatientSummary();
    } else if (newTab === 'lists') {
      if (listsComponentRef.value) {
        listsComponentRef.value.reloadCategories();
        listsComponentRef.value.loadWizardAutoFlow();
        listsComponentRef.value.attemptAutoProcessInitialFile();
      }
    } else if (newTab === 'diary') {
      loadDiary();
    } else if (newTab === 'references') {
      loadReferences();
    }
  }
});

// Clean up polling interval on component unmount
onUnmounted(() => {
  if (pollingInterval.value) {
    clearInterval(pollingInterval.value);
    pollingInterval.value = null;
  }
  if (elapsedTimeInterval.value) {
    clearInterval(elapsedTimeInterval.value);
    elapsedTimeInterval.value = null;
  }
});
</script>

<style scoped lang="scss">
.q-item {
  cursor: default;
}

.verify-highlight {
  box-shadow: 0 0 0 2px #e53935;
  border-radius: 6px;
}
</style>
