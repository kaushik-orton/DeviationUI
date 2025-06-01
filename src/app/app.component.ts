import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { Observable, forkJoin, of } from 'rxjs';
import { map, startWith } from 'rxjs/operators';
import { FormsModule } from '@angular/forms';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, HttpClientModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  title = 'TCW_Deviation';
  form: FormGroup;
  coins: string[] = [];
  filteredCoins: string[] = [];
  showDropdown = false;
  http = inject(HttpClient);
  fb = inject(FormBuilder);
  alerts: any[] = [];
  pagedAlerts: any[] = [];
  page = 1;
  pageSize = 5;
  totalPages = 1;
  prices: { [symbol: string]: number } = {};
  searchTerm: string = '';
  allAlerts: any[] = [];

  constructor() {
    this.form = this.fb.group({
      coinName: ['', Validators.required],
      price: ['', [Validators.required, Validators.pattern(/^[0-9]+(\.[0-9]+)?$/)]],
      price2: ['', [Validators.pattern(/^[0-9]+(\.[0-9]+)?$/)]],
      type: ['long', Validators.required],
      comments: ['']
    });
    this.getPairs();
    this.form.get('coinName')!.valueChanges.subscribe(value => {
      this.filterCoins(value || '');
      this.showDropdown = false;
    });
  }

  ngOnInit() {
    this.fetchAlerts();
  }

  getPairs() {
    let perpURL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
    forkJoin({
      perp: this.http.get<any>(perpURL)
    }).subscribe({
      next: ({ perp }) => {
        this.coins = perp.symbols
          .filter((s: any) => s.quoteAsset === 'USDT')
          .map((s: any) => s.symbol);
      },
      error(err) {
        console.log(err);
      },
      complete() {
        console.log('done with fetching pairs');
      }
    });
  }

  openDropdown() {
    this.showDropdown = true;
    this.filterCoins(this.form.get('coinName')!.value || '');
  }

  filterCoins(value: string) {
    const filterValue = value.trim().toUpperCase();
    if (!filterValue) {
      this.filteredCoins = this.coins.slice();
    } else {
      this.filteredCoins = this.coins.filter(option => option.toUpperCase().includes(filterValue));
    }
  }

  onCoinInput(event: any) {
    const value = event.target.value;
    this.filterCoins(value);
    this.showDropdown = true;
  }

  selectCoin(coin: string) {
    this.form.get('coinName')!.setValue(coin);
    this.showDropdown = false;
    this.form.get('coinName')!.setErrors(null);
  }

  onCoinBlur() {
    setTimeout(() => {
      if (!this.coins.includes(this.form.get('coinName')!.value)) {
        this.form.get('coinName')!.setValue('');
        this.form.get('coinName')!.setErrors({ required: true });
      }
      this.showDropdown = false;
    }, 150);
  }

  fetchAlerts() {
    this.http.get<any[]>(`${environment.apiUrl}/alerts`).subscribe({
      next: (data) => {
        this.allAlerts = (data || []).sort((a, b) => new Date(b.signalTime).getTime() - new Date(a.signalTime).getTime());
        this.applySearch();
        this.page = 1;
        this.updatePagedAlerts();
        this.fetchCurrentPrices();
      },
      error: () => {
        this.allAlerts = [];
        this.applySearch();
        this.updatePagedAlerts();
      }
    });
  }

  fetchCurrentPrices() {
    if (!this.alerts.length) return;
    const symbols = Array.from(new Set(this.alerts.map(a => a.symbol)));
    const url = `https://fapi.binance.com/fapi/v1/ticker/price`;
    this.http.get<any[]>(url).subscribe({
      next: (allPrices) => {
        this.prices = {};
        for (const symbol of symbols) {
          const found = allPrices.find(p => p.symbol === symbol);
          if (found) this.prices[symbol] = parseFloat(found.price);
        }
        this.checkDCAHits();
      },
      error: () => {
        this.prices = {};
      }
    });
  }

  checkDCAHits() {
    let changed = false;
    for (let i = this.alerts.length - 1; i >= 0; i--) {
      const alert = this.alerts[i];
      const price = this.prices[alert.symbol];
      if (price === undefined) continue;
      if (alert.entryPrice2 !== undefined) {
        if (!alert.hit1 && Math.abs(price - alert.entryPrice) < 0.0001) {
          alert.hit1 = true;
          alert.hit1Time = new Date().toISOString();
          alert._notified1 = true;
        }
        if (!alert.hit2 && Math.abs(price - alert.entryPrice2) < 0.0001) {
          alert.hit2 = true;
          alert.hit2Time = new Date().toISOString();
          alert._notified2 = true;
        }
        if (alert.hit1 && alert.hit2) {
          this.alerts.splice(i, 1);
          changed = true;
        }
      } else {
        if (!alert.hit1 && Math.abs(price - alert.entryPrice) < 0.0001) {
          alert.hit1 = true;
          alert.hit1Time = new Date().toISOString();
          alert._notified1 = true;
          this.alerts.splice(i, 1);
          changed = true;
        }
      }
    }
    if (changed) {
      this.http.post(`${environment.apiUrl}/alerts-overwrite`, this.alerts).subscribe(() => {
        this.fetchAlerts();
      });
    }
  }

  updatePagedAlerts() {
    this.totalPages = Math.ceil(this.alerts.length / this.pageSize) || 1;
    const start = (this.page - 1) * this.pageSize;
    this.pagedAlerts = this.alerts.slice(start, start + this.pageSize);
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.page = page;
    this.updatePagedAlerts();
  }

  onSubmit() {
    if (this.form.valid) {
      const now = new Date();
      const alertObj: any = {
        symbol: this.form.value.coinName,
        side: this.form.value.type,
        entryPrice: parseFloat(this.form.value.price),
        tag: this.form.value.comments || '',
        signalTime: now.toISOString(),
      };
      if (this.form.value.price2) {
        alertObj.entryPrice2 = parseFloat(this.form.value.price2);
        alertObj.hit1 = false;
        alertObj.hit2 = false;
      } else {
        alertObj.hit1 = false;
      }
      this.http.post(`${environment.apiUrl}/alerts`, alertObj).subscribe({
        next: (res) => {
          this.form.reset({ type: 'long' });
          this.fetchAlerts();
        },
        error: (err) => {
          // Optionally handle error
        }
      });
    }
  }

  deleteAlert(index: number) {
    const globalIndex = (this.page - 1) * this.pageSize + index;
    const alertToDelete = this.alerts[globalIndex];
    this.alerts.splice(globalIndex, 1);
    this.updatePagedAlerts();
    this.http.post(`${environment.apiUrl}/alerts-overwrite`, this.alerts).subscribe({
      next: () => {
        this.fetchAlerts();
      },
      error: () => {
        // Optionally handle error
      }
    });
  }

  isInvalidated(alert: any): boolean {
    const now = new Date();
    const alertTime = new Date(alert.signalTime);
    return (now.getTime() - alertTime.getTime()) > 24 * 60 * 60 * 1000;
  }

  onSearchChange() {
    this.applySearch();
    this.page = 1;
    this.updatePagedAlerts();
  }

  applySearch() {
    const term = this.searchTerm.trim().toLowerCase();
    if (!term) {
      this.alerts = [...this.allAlerts];
    } else {
      this.alerts = this.allAlerts.filter(alert =>
        alert.symbol.toLowerCase().includes(term) ||
        (alert.side && alert.side.toLowerCase().includes(term))
      );
    }
  }
}

//test commit
