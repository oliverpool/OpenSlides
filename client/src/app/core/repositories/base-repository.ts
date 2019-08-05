import { TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { auditTime } from 'rxjs/operators';

import { Collection } from 'app/shared/models/base/collection';
import { BaseModel, ModelConstructor } from '../../shared/models/base/base-model';
import { BaseViewModel, TitleInformation, ViewModelConstructor } from '../../site/base/base-view-model';
import { CollectionStringMapperService } from '../core-services/collection-string-mapper.service';
import { DataSendService } from '../core-services/data-send.service';
import { CollectionIds, DataStoreService } from '../core-services/data-store.service';
import { Identifiable } from '../../shared/models/base/identifiable';
import { OnAfterAppsLoaded } from '../definitions/on-after-apps-loaded';
import { RelationManagerService } from '../core-services/relation-manager.service';
import {
    isNormalRelationDefinition,
    isReverseRelationDefinition,
    RelationDefinition,
    ReverseRelationDefinition
} from '../definitions/relations';
import { ViewModelStoreService } from '../core-services/view-model-store.service';

export abstract class BaseRepository<V extends BaseViewModel & T, M extends BaseModel, T extends TitleInformation>
    implements OnAfterAppsLoaded, Collection {
    /**
     * Stores all the viewModel in an object
     */
    protected viewModelStore: { [modelId: number]: V } = {};

    /**
     * Stores subjects to viewModels in a list
     */
    protected viewModelSubjects: { [modelId: number]: BehaviorSubject<V> } = {};

    /**
     * Observable subject for the whole list. These entries are unsorted an not piped through
     * autodTime. Just use this internally.
     *
     * It's used to debounce messages on the sortedViewModelListSubject
     */
    protected readonly unsafeViewModelListSubject: BehaviorSubject<V[]> = new BehaviorSubject<V[]>(null);

    /**
     * Observable subject for the sorted view model list.
     *
     * All data is piped through an auditTime of 1ms. This is to prevent massive
     * updates, if e.g. an autoupdate with a lot motions come in. The result is just one
     * update of the new list instead of many unnecessary updates.
     */
    protected readonly viewModelListSubject: BehaviorSubject<V[]> = new BehaviorSubject<V[]>([]);

    /**
     * Observable subject for any changes of view models.
     */
    protected readonly generalViewModelSubject: Subject<V> = new Subject<V>();

    /**
     * Can be used by the sort functions.
     */
    protected languageCollator: Intl.Collator;

    /**
     * The collection string of the managed model.
     */
    private _collectionString: string;

    public get collectionString(): string {
        return this._collectionString;
    }

    /**
     * Needed for the collectionStringMapper service to treat repositories the same as
     * ModelConstructors and ViewModelConstructors.
     */
    public get COLLECTIONSTRING(): string {
        return this._collectionString;
    }

    public abstract getVerboseName: (plural?: boolean) => string;
    public abstract getTitle: (titleInformation: T) => string;

    /**
     * Maps the given relations (`relationDefinitions`) to their affected collections. This means,
     * if a model of the collection updates, the relation needs to be updated.
     *
     * Attention: Some inherited repos might put other relations than RelationDefinition in here, so
     * *always* check the type of the relation.
     */
    protected relationsByCollection: { [collection: string]: RelationDefinition<BaseViewModel>[] } = {};

    protected reverseRelationsByCollection: { [collection: string]: ReverseRelationDefinition<BaseViewModel>[] } = {};

    /**
     * The view model ctor of the encapsulated view model.
     */
    protected baseViewModelCtor: ViewModelConstructor<V>;

    /**
     * Construction routine for the base repository
     *
     * @param DS: The DataStore
     * @param collectionStringMapperService Mapping strings to their corresponding classes
     * @param baseModelCtor The model constructor of which this repository is about.
     * @param depsModelCtors A list of constructors that are used in the view model.
     * If one of those changes, the view models will be updated.
     */
    public constructor(
        protected DS: DataStoreService,
        protected dataSend: DataSendService,
        protected collectionStringMapperService: CollectionStringMapperService,
        protected viewModelStoreService: ViewModelStoreService,
        protected translate: TranslateService,
        protected relationManager: RelationManagerService,
        protected baseModelCtor: ModelConstructor<M>,
        protected relationDefinitions: RelationDefinition<BaseViewModel>[] = []
    ) {
        this._collectionString = baseModelCtor.COLLECTIONSTRING;

        this.groupRelationsByCollections();
        this.buildReverseRelationsGrouping();

        // All data is piped through an auditTime of 1ms. This is to prevent massive
        // updates, if e.g. an autoupdate with a lot motions come in. The result is just one
        // update of the new list instead of many unnecessary updates.
        this.unsafeViewModelListSubject.pipe(auditTime(1)).subscribe(models => {
            if (models) {
                this.viewModelListSubject.next(models.sort(this.viewModelSortFn));
            }
        });

        this.languageCollator = new Intl.Collator(this.translate.currentLang);
    }

    /**
     * Reorders the relations to provide faster access.
     */
    protected groupRelationsByCollections(): void {
        this.relationDefinitions.forEach(relation => {
            this._groupRelationsByCollections(relation, relation);
        });
    }

    /**
     * Recursive function for reorderung the relations.
     */
    protected _groupRelationsByCollections(relation: RelationDefinition, baseRelation: RelationDefinition): void {
        if (relation.type === 'nested') {
            (relation.relationDefinition || []).forEach(nestedRelation => {
                this._groupRelationsByCollections(nestedRelation, baseRelation);
            });
        } else if (
            relation.type === 'M2O' ||
            relation.type === 'M2M' ||
            relation.type === 'O2M' ||
            relation.type === 'custom'
        ) {
            const collection = relation.foreignModel.COLLECTIONSTRING;
            if (!this.relationsByCollection[collection]) {
                this.relationsByCollection[collection] = [];
            }
            this.relationsByCollection[collection].push(baseRelation);
        } else if (relation.type === 'generic') {
            relation.possibleModels.forEach(ctor => {
                const collection = ctor.COLLECTIONSTRING;
                if (!this.relationsByCollection[collection]) {
                    this.relationsByCollection[collection] = [];
                }
                this.relationsByCollection[collection].push(baseRelation);
            });
        }
    }

    protected buildReverseRelationsGrouping(): void {
        Object.keys(this.relationsByCollection).forEach(collection => {
            const reverseRelations = this.relationsByCollection[collection].filter(relation =>
                isReverseRelationDefinition(relation)
            ) as ReverseRelationDefinition<BaseViewModel>[];
            if (reverseRelations.length) {
                this.reverseRelationsByCollection[collection] = reverseRelations;
            }
        });
    }

    public onAfterAppsLoaded(): void {
        this.baseViewModelCtor = this.collectionStringMapperService.getViewModelConstructor(this.collectionString);
        this.DS.clearObservable.subscribe(() => this.clear());
        this.translate.onLangChange.subscribe(change => {
            this.languageCollator = new Intl.Collator(change.lang);
            if (this.unsafeViewModelListSubject.value) {
                this.viewModelListSubject.next(this.unsafeViewModelListSubject.value.sort(this.viewModelSortFn));
            }
        });
    }

    public getListTitle: (titleInformation: T) => string = (titleInformation: T) => {
        return this.getTitle(titleInformation);
    };

    /**
     * Deletes all models from the repository (internally, no requests). Changes need
     * to be committed via `commitUpdate()`.
     *
     * @param ids All model ids
     */
    public deleteModels(ids: number[]): void {
        ids.forEach(id => {
            delete this.viewModelStore[id];
            this.updateViewModelObservable(id);
        });
    }

    /**
     * Updates or creates all given models in the repository (internally, no requests).
     * Changes need to be committed via `commitUpdate()`.
     *
     * @param ids All model ids.
     */
    public changedModels(ids: number[]): void {
        ids.forEach(id => {
            this.viewModelStore[id] = this.createViewModelWithTitles(this.DS.get(this.collectionString, id));
            this.updateViewModelObservable(id);
        });
    }

    /**
     * After creating a view model, all functions for models form the repo
     * are assigned to the new view model.
     */
    protected createViewModelWithTitles(model: M): V {
        const viewModel = this.relationManager.createViewModel(model, this.baseViewModelCtor, this.relationDefinitions);
        viewModel.getTitle = () => this.getTitle(viewModel);
        viewModel.getListTitle = () => this.getListTitle(viewModel);
        viewModel.getVerboseName = this.getVerboseName;
        return viewModel;
    }

    /**
     * Updates all models in this repository with all changed models.
     *
     * @param changedModels A mapping of collections to ids of all changed models.
     * @returns if at least one model was affected.
     */
    public updateDependenciesForChangedModels(changedModels: CollectionIds): boolean {
        if (!this.relationDefinitions.length) {
            return false;
        }

        // Get all viewModels from this repo once.
        const ownViewModels = this.getViewModelList();
        const updatedIds = [];
        Object.keys(changedModels).forEach(collection => {
            const dependencyChanged: boolean = Object.keys(this.relationsByCollection).includes(collection);
            if (!dependencyChanged) {
                return;
            }

            // Ok, we are affected by this collection. Update all viewModels from this repo.
            const relations = this.relationsByCollection[collection];
            ownViewModels.forEach(ownViewModel => {
                relations.forEach(relation => {
                    changedModels[collection].forEach(id => {
                        if (
                            this.relationManager.updateSingleDependencyForChangedModel(
                                ownViewModel,
                                relation,
                                collection,
                                id
                            )
                        ) {
                            updatedIds.push(ownViewModel.id);
                        }
                    });
                });
            });
            // Order all relations, if neeed.
            if (updatedIds.length) {
                relations.forEach(relation => {
                    if (
                        (isNormalRelationDefinition(relation) || isReverseRelationDefinition(relation)) &&
                        (relation.type === 'M2M' || relation.type === 'O2M') &&
                        relation.order
                    ) {
                        ownViewModels.forEach(ownViewModel => {
                            if (ownViewModel['_' + relation.ownKey]) {
                                this.relationManager.sortByRelation(relation, ownViewModel);
                            }
                        });
                    }
                });
            }

            // Inform about changes. (List updates is done in `commitUpdate` via `DataStoreUpdateManagerService`)
            updatedIds.forEach(id => {
                this.updateViewModelObservable(id);
            });
        });
        return !!updatedIds.length;
    }

    public updateDependenciesForDeletedModels(deletedModels: CollectionIds): boolean {
        if (!Object.keys(this.reverseRelationsByCollection).length) {
            return false;
        }

        // Get all viewModels from this repo once.
        const ownViewModels = this.getViewModelList();
        let somethingChanged = false;
        Object.keys(deletedModels).forEach(collection => {
            const dependencyChanged: boolean = Object.keys(this.reverseRelationsByCollection).includes(collection);
            if (!dependencyChanged) {
                return;
            }

            // Ok, we are affected by this collection. Update all viewModels from this repo.
            const relations = this.reverseRelationsByCollection[collection];
            ownViewModels.forEach(ownViewModel => {
                relations.forEach(relation => {
                    deletedModels[collection].forEach(id => {
                        if (this.relationManager.updateSingleDependencyForDeletedModel(ownViewModel, relation, id)) {
                            // Inform about changes. (List updates is done in `commitUpdate` via `DataStoreUpdateManagerService`)
                            this.updateViewModelObservable(id);
                            somethingChanged = true;
                        }
                    });
                });
            });
            // Ordering all relations is not needed, because just deleting things out of arrays
            // will not unorder them.
        });
        return somethingChanged;
    }

    /**
     * Saves the (full) update to an existing model. So called "update"-function
     * Provides a default procedure, but can be overwritten if required
     *
     * @param update the update that should be created
     * @param viewModel the view model that the update is based on
     */
    public async update(update: Partial<M>, viewModel: V): Promise<void> {
        const sendUpdate = new this.baseModelCtor();
        sendUpdate.patchValues(viewModel.getModel());
        sendUpdate.patchValues(update);
        return await this.dataSend.updateModel(sendUpdate);
    }

    /**
     * patches an existing model with new data,
     * rather than sending a full update
     *
     * @param update the update to send
     * @param viewModel the motion to update
     */
    public async patch(update: Partial<M>, viewModel: V): Promise<void> {
        const patch = new this.baseModelCtor();
        patch.id = viewModel.id;
        patch.patchValues(update);
        return await this.dataSend.partialUpdateModel(patch);
    }

    /**
     * Deletes a given Model
     * Provides a default procedure, but can be overwritten if required
     *
     * @param viewModel the view model to delete
     */
    public async delete(viewModel: V): Promise<void> {
        return await this.dataSend.deleteModel(viewModel.getModel());
    }

    /**
     * Creates a new model.
     * Provides a default procedure, but can be overwritten if required
     *
     * @param model the model to create on the server
     */
    public async create(model: M): Promise<Identifiable> {
        // this ensures we get a valid base model, even if the view was just
        // sending an object with "as MyModelClass"
        const sendModel = new this.baseModelCtor();
        sendModel.patchValues(model);

        // Strips empty fields from the sending mode data (except false)
        // required for i.e. users, since group list is mandatory
        Object.keys(sendModel).forEach(key => {
            if (!sendModel[key] && sendModel[key] !== false) {
                delete sendModel[key];
            }
        });

        return await this.dataSend.createModel(sendModel);
    }

    /**
     * Clears the repository.
     */
    protected clear(): void {
        this.viewModelStore = {};
    }
    /**
     * The function used for sorting the data of this repository. The defualt sorts by ID.
     */
    protected viewModelSortFn: (a: V, b: V) => number = (a: V, b: V) => a.id - b.id;

    /**
     * Setter for a sort function. Updates the sorting.
     *
     * @param fn a sort function
     */
    public setSortFunction(fn: (a: V, b: V) => number): void {
        this.viewModelSortFn = fn;
        this.commitUpdate();
    }

    /**
     * helper function to return one viewModel
     */
    public getViewModel(id: number): V {
        return this.viewModelStore[id];
    }

    /**
     * @returns all view models stored in this repository. Sorting is not guaranteed
     */
    public getViewModelList(): V[] {
        return Object.values(this.viewModelStore);
    }

    /**
     * Get a sorted ViewModelList. This passes through a (1ms short) delay,
     * thus may not be accurate, especially on application loading.
     *
     * @returns all sorted view models stored in this repository.
     */
    public getSortedViewModelList(): V[] {
        return this.viewModelListSubject.getValue();
    }

    /**
     * @returns the current observable for one viewModel
     */
    public getViewModelObservable(id: number): Observable<V> {
        if (!this.viewModelSubjects[id]) {
            this.viewModelSubjects[id] = new BehaviorSubject<V>(this.viewModelStore[id]);
        }
        return this.viewModelSubjects[id].asObservable();
    }

    /**
     * @returns the (sorted) Observable of the whole store.
     */
    public getViewModelListObservable(): Observable<V[]> {
        return this.viewModelListSubject.asObservable();
    }

    /**
     * Returns the ViewModelList as piped Behavior Subject.
     * Prevents unnecessary calls.
     *
     * @returns A subject that holds the model list
     */
    public getViewModelListBehaviorSubject(): BehaviorSubject<V[]> {
        return this.viewModelListSubject;
    }

    /**
     * This observable fires every time an object is changed in the repository.
     */
    public getGeneralViewModelObservable(): Observable<V> {
        return this.generalViewModelSubject.asObservable();
    }

    /**
     * Updates the ViewModel observable using a ViewModel corresponding to the id
     */
    protected updateViewModelObservable(id: number): void {
        if (this.viewModelSubjects[id]) {
            this.viewModelSubjects[id].next(this.viewModelStore[id]);
        }
        this.generalViewModelSubject.next(this.viewModelStore[id]);
    }

    /**
     * update the observable of the list. Also updates the sorting of the view model list.
     */
    public commitUpdate(): void {
        this.unsafeViewModelListSubject.next(this.getViewModelList());
    }
}
