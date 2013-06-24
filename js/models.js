/**
 * Models for MinnPost crime app
 */
(function(app, $, undefined) {

  /**
   * Basic model for other crime models
   */
  app.ModelCrime = Backbone.Model.extend({
    dataCrimeQueryBase: 'https://api.scraperwiki.com/api/1.0/datastore/sqlite?format=jsondict&name=minneapolis_aggregate_crime_data&callback=?&query=[[[QUERY]]]',
    // See scraper for why this is needed
    dataCrimeQueryWhere: "notes NOT LIKE 'Added to%'",
  
    // Get most recent month and year
    fetchRecentMonth: function(done, context) {
      context = context || this;
      var query = "SELECT month, year FROM swdata ORDER BY year || '-' || month DESC LIMIT 1";
      var defer = $.jsonp({ url: this.dataCrimeQueryBase.replace('[[[QUERY]]]', encodeURI(query)) });
      
      if (_.isFunction(done)) {
        $.when(defer).done(function(data) {
          done.apply(context, [data[0].year, data[0].month]);
        });
      }
      return defer;
    },
    
    // We have population data from 2000 and 2010, so we abstract
    // that out to fill in years
    createPopulationYears: function() {
      var baseData = this.get('population');
      var popData = {};
      var rate = (baseData[2010] - baseData[2000]) / 10;
      var year = 2000;
      
      for (year; year <= 2020; year++) {
        // Estimate population based on year
        popData[year] = baseData[2000] + (rate * (year - 2000));
      }
      
      this.set('population', popData);
      return this;
    }
  });

  /**
   * Model for city level data
   */
  app.ModelCity = app.ModelCrime.extend({
    initialize: function() {
      this.set('categories', app.data['crime/categories']);
      this.createPopulationYears();
    },
  
    // Set stats values
    setStats: function(stat) {
      stat = stat || 'total';
      
      this.set('lastMonthChange', this.getMonthChange(
        this.get('lastMonthYear'), this.get('lastMonthMonth'), stat));
      this.set('lastYearMonthChange', this.getMonthChange(
        this.get('currentYear') - 1, this.get('currentMonth'), stat));
      return this;
    },
    
    // Gets years data relative to current month
    getLastYearData: function(years, stat) {
      years = years || 1;
      stat = stat || 'total';
      var data = [];
      var count = 0;
      
      if (_.isObject(this.get('crimesByMonth'))) {
        var filtered = this.getFilteredCrimesByMonth(
          this.get('currentYear') - years, this.get('currentMonth'),
          this.get('currentYear') - (years - 1), this.get('currentMonth'));

        _.each(filtered, function(year, y) {
          _.each(year, function(month, m) {
            data.push([moment(m.toString(), 'MM').format('MMM'), month[stat]]);
          });
        });
      }
      
      return data;
    },
  
    // Determine change between two months
    getMonthChange: function(year1, month1, stat, year2, month2) {
      year2 = year2 || this.get('currentYear');
      month2 = month2 || this.get('currentMonth');
      stat = stat || 'total';
    
      var crime1 = this.getCrimeByMonth(year1, month1, stat);
      var crime2 = this.getCrimeByMonth(year2, month2, stat);
      // Can't divide by zero, so percentage difference from
      // zero is actually subject, we choose a value so that a 1
      // change would be 100%
      // (1 - x) / x = 1
      
      return (crime2 - crime1) / ((crime1 === 0) ? 0.5 : crime1);
    },
    
    // Get a crime state for month
    getCrimeByMonth: function(year, month, stat) {
      stat = stat || 'total';
      return this.get('crimesByMonth')[year][month][stat];
    },
    
    // Filter crimes
    getFilteredCrimesByMonth: function(year1, month1, year2, month2) {
      year2 = year2 || this.get('currentYear');
      month2 = month2 || this.get('currentMonth');
      var filtered = {};
      
      _.each(this.get('crimesByMonth'), function(year, y) {
        _.each(year, function(month, m) {
          if ((y == year1 && m > month1) ||
            (y == year2 && m <= month2) ||
            ((year2 - year1) > 1 && y > year1 && y < year2)
          ) {
            filtered[y] = filtered[y] || {};
            filtered[y][m] = month;
          }
        });
      });
      
      return filtered;
    },
    
    // Get last month, as it could be last year
    setLastMonth: function() {
      var month = this.get('currentMonth');
      var year = this.get('currentYear');
      var response = [year, month - 1];
      
      if (month == 1) {
        response = [year - 1, 12];
      }
      this.set('lastMonthMonth', response[1]);
      this.set('lastMonthYear', response[0]);
      return this;
    },
  
    // Get all that sweet, sweet data
    fetchData: function(done, context) {
      var thisModel = this;
      context = context || this;
    
      // First get the most recent month/year
      this.fetchRecentMonth(function(year, month) {
        var defers = [];
        var lastMonth;
        
        this.set('currentMonth', month);
        this.set('currentYear', year);
        this.setLastMonth();
        
        // Get data for various months (current, last, and last year)
        defers.push(this.fetchDataPreviousYearsByMonth(year, month, 2));
        $.when.apply($, defers).done(function() {
          var data = thisModel.get('data') || {};
          _.each(arguments[0], function(r) {
            data[r.year] = data[r.year] || {};
            data[r.year][r.month] = r;
          });
          thisModel.set('crimesByMonth', data);
          thisModel.setStats();
          
          // Done and callback
          done.apply(context, []);
        });
      }, this);
      return this;
    },
    
    // Get data aggregate by month for previous years
    fetchDataPreviousYearsByMonth: function(year, month, years, done, context) {
      years = (_.isNumber(years)) ? years : 1;
      var query = [];
      
      query.push("SELECT year, month");
      _.each(this.get('categories'), function(category, c) {
        query.push(", SUM(" + c + ") AS " + c);
      });
      query.push(" FROM swdata WHERE " + this.dataCrimeQueryWhere);
      query.push(" AND ((year = " + year + " AND month <= " + month + ") ");
      if (years > 1) {
        query.push(" OR (year < " + year + " AND year > " + (year - years) + ")");
      }
      query.push(" OR (year = " + (year - years) + " AND month >= " + month + "))");
      query.push(" GROUP BY year, month ORDER BY year DESC, month DESC");
      
      var defer = $.jsonp({ url: this.dataCrimeQueryBase.replace('[[[QUERY]]]', encodeURI(query.join(''))) });
  
      if (_.isFunction(done)) {
        $.when(defer).done(function(data) {
          done.apply(context, [data[0]]);
        });
      }
      return defer;
    }
  });

  /**
   * Model for neighborhood level data
   */
  app.ModelNeighborhood = app.ModelCrime.extend({
  
    initialize: function() {
      this.set('categories', app.data['crime/categories']);
      this.createPopulationYears();
    },
  
    // Get all that sweet, sweet data
    fetchData: function(done, context) {
      var thisModel = this;
      context = context || this;
    }
    
  });


})(mpApp['minnpost-crime'], jQuery);