import { ChangeDetectionStrategy, Component, EventEmitter, OnInit, Output } from '@angular/core';
import { Observable } from 'rxjs';

import { DataService } from '../../../data/providers/data.service';
import { FacetValue } from '../../../data/types/gql-generated-types';

export type FacetValueSeletorItem = { name: string; facetName: string; id: string; value: FacetValue };

@Component({
    selector: 'vdr-facet-value-selector',
    templateUrl: './facet-value-selector.component.html',
    styleUrls: ['./facet-value-selector.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FacetValueSelectorComponent implements OnInit {
    @Output() selectedValuesChange = new EventEmitter<FacetValue[]>();

    facetValues$: Observable<FacetValueSeletorItem[]>;
    constructor(private dataService: DataService) {}

    ngOnInit() {
        this.facetValues$ = this.dataService.facet.getFacets(9999999, 0).mapSingle(result => {
            return result.facets.items.reduce(
                (flattened, facet) => {
                    return flattened.concat(
                        facet.values.map(value => {
                            return {
                                name: value.name,
                                facetName: facet.name,
                                id: value.id,
                                value,
                            };
                        }),
                    );
                },
                [] as FacetValueSeletorItem[],
            );
        });
    }

    onChange(selected: FacetValueSeletorItem[]) {
        this.selectedValuesChange.emit(selected.map(s => s.value));
    }
}